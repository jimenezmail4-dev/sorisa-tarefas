// GESTOR DE TAREFAS SORISA — Calendar como base de dados
var CALENDAR_NAME = 'Tarefas SORISA';

function doGet(e) {
  var action = e.parameter.action || '';

  if (!action) {
    return HtmlService.createHtmlOutputFromFile('index')
      .setTitle('Tarefas SORISA')
      .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
      .addMetaTag('viewport', 'width=device-width, initial-scale=1.0');
  }

  var result;
  try {
    if      (action === 'getTasks')   result = getTasks();
    else if (action === 'createTask') result = createTask(e.parameter);
    else if (action === 'updateTask') result = updateTask(e.parameter);
    else if (action === 'deleteTask') result = deleteTask(e.parameter);
    else if (action === 'getBusy')    result = getBusy(e.parameter.date);
    else result = { error: 'Acao desconhecida: ' + action };
  } catch(err) {
    result = { error: err.message };
  }

  return ContentService
    .createTextOutput(JSON.stringify(result))
    .setMimeType(ContentService.MimeType.JSON);
}

// ── AGENDA ───────────────────────────────────────────
function getTaskCalendar() {
  var cals = CalendarApp.getCalendarsByName(CALENDAR_NAME);
  if (cals.length > 0) return cals[0];
  return CalendarApp.createCalendar(CALENDAR_NAME, { color: CalendarApp.Color.CYAN });
}

// ── META ─────────────────────────────────────────────
function serializeMeta(p) {
  return '[TAREFA]\nprioridade: ' + (p.priority||'media') +
    '\nestado: '  + (p.status  ||'fazer') +
    '\ncriado: '  + (p.created ||'') +
    '\nnotas: '   + (p.notes   ||'') +
    '\n[/TAREFA]';
}

function parseMeta(desc) {
  var meta = { priority:'media', status:'fazer', created:'', notes:'' };
  if (!desc) return meta;
  var block = desc.match(/\[TAREFA\]([\s\S]*?)\[\/TAREFA\]/);
  if (!block) return meta;
  block[1].split('\n').forEach(function(line) {
    var m = line.match(/^(\w+):\s*(.*)/);
    if (!m) return;
    if      (m[1]==='prioridade') meta.priority = m[2].trim();
    else if (m[1]==='estado')     meta.status   = m[2].trim();
    else if (m[1]==='criado')     meta.created  = m[2].trim();
    else if (m[1]==='notas')      meta.notes    = m[2].trim();
  });
  return meta;
}

function eventToTask(ev) {
  var meta   = parseMeta(ev.getDescription());
  var tz     = Session.getScriptTimeZone();
  var allDay = ev.isAllDayEvent();
  var title  = ev.getTitle();
  // Remove prefixo [Tarefa] se existir (tarefas antigas)
  title = title.replace(/^\[Tarefa\]\s*/, '');
  return {
    id:        ev.getId(),
    text:      title,
    due:       Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
    startTime: allDay ? '' : Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
    endTime:   allDay ? '' : Utilities.formatDate(ev.getEndTime(),   tz, 'HH:mm'),
    priority:  meta.priority,
    status:    meta.status,
    created:   meta.created,
    notes:     meta.notes,
  };
}

// ── CRUD ─────────────────────────────────────────────
function getTasks() {
  var past   = new Date(); past.setFullYear(past.getFullYear()-1);
  var future = new Date(); future.setFullYear(future.getFullYear()+2);
  var seen   = {};
  var results = [];

  // 1. Agenda "Tarefas SORISA"
  getTaskCalendar().getEvents(past, future).forEach(function(ev) {
    seen[ev.getId()] = true;
    results.push(eventToTask(ev));
  });

  // 2. Calendário principal — eventos com prefixo [Tarefa]
  CalendarApp.getDefaultCalendar().getEvents(past, future).forEach(function(ev) {
    if (seen[ev.getId()]) return;
    if (ev.getTitle().indexOf('[Tarefa]') === 0) {
      seen[ev.getId()] = true;
      results.push(eventToTask(ev));
    }
  });

  return results;
}

function createTask(p) {
  var cal  = getTaskCalendar();
  var desc = serializeMeta(p);
  var ev;
  var startTime, endTime;
  if (p.startTime && p.startTime !== '') {
    startTime = p.startTime;
    endTime   = (p.endTime && p.endTime !== '') ? p.endTime : addMinutesToTime(p.startTime, 30);
  } else {
    // Encontra o primeiro slot livre de 30 min no dia
    var freeSlot = findFirstFreeSlot(p.due || todayStr());
    startTime = freeSlot.start;
    endTime   = freeSlot.end;
  }
  var start = parseDateTime(p.due || todayStr(), startTime);
  var end   = parseDateTime(p.due || todayStr(), endTime);
  ev = cal.createEvent(p.text, start, end, { description: desc });
  setPriColor(ev, p.priority);
  return eventToTask(ev);
}

function updateTask(p) {
  var ev = findEventById(p.eventId);
  if (!ev) return { error: 'Tarefa não encontrada: ' + p.eventId };
  ev.setTitle(p.text || ev.getTitle());
  ev.setDescription(serializeMeta(p));
  setPriColor(ev, p.priority);
  if (p.due) {
    var startTime, endTime;
    if (p.startTime && p.startTime !== '') {
      startTime = p.startTime;
      endTime   = (p.endTime && p.endTime !== '') ? p.endTime : addMinutesToTime(p.startTime, 30);
    } else {
      var freeSlot = findFirstFreeSlot(p.due);
      startTime = freeSlot.start;
      endTime   = freeSlot.end;
    }
    ev.setTime(parseDateTime(p.due, startTime), parseDateTime(p.due, endTime));
  }
  return eventToTask(ev);
}

function deleteTask(p) {
  var ev = findEventById(p.eventId);
  if (!ev) return { error: 'Tarefa não encontrada' };
  ev.deleteEvent();
  return { deleted: true };
}

// Procura evento em todos os calendários relevantes
function findEventById(eventId) {
  var past   = new Date(); past.setFullYear(past.getFullYear()-1);
  var future = new Date(); future.setFullYear(future.getFullYear()+2);
  var cals   = [getTaskCalendar(), CalendarApp.getDefaultCalendar()];
  for (var i=0; i<cals.length; i++) {
    try {
      var evs = cals[i].getEvents(past, future);
      for (var j=0; j<evs.length; j++) {
        if (evs[j].getId() === eventId) return evs[j];
      }
    } catch(e) {}
  }
  return null;
}


// ── BATCH OPERATIONS ─────────────────────────────────
function batchUpdateTasks(items) {
  var errors = [];
  items.forEach(function(p) {
    try { updateTask(p); } catch(e) { errors.push(e.message); }
  });
  return errors.length ? { error: errors.join('; ') } : { updated: items.length };
}

function batchDeleteTasks(ids) {
  var errors = [];
  ids.forEach(function(id) {
    try { deleteTask({ eventId: id }); } catch(e) { errors.push(e.message); }
  });
  return errors.length ? { error: errors.join('; ') } : { deleted: ids.length };
}

// ── EVENTOS PRÓXIMOS (calendário principal) ───────────
function getUpcomingEvents() {
  var now = new Date(), end = new Date();
  end.setDate(end.getDate()+14);
  var tz = Session.getScriptTimeZone();
  return CalendarApp.getDefaultCalendar().getEvents(now, end).map(function(ev) {
    return {
      title:     ev.getTitle(),
      start:     Utilities.formatDate(ev.getStartTime(), tz, 'yyyy-MM-dd'),
      startTime: ev.isAllDayEvent() ? '' : Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm')
    };
  });
}

// ── SLOTS OCUPADOS ────────────────────────────────────
function getBusy(date) {
  if (!date) return [];
  var parts    = date.split('-');
  var dayStart = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]),  0,  0,  0);
  var dayEnd   = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]), 23, 59, 59);
  var tz       = Session.getScriptTimeZone();
  var busy = [];

  // Bloqueia sempre 13:00-15:00 (pausa fixa)
  busy.push({ start: '13:00', end: '15:00' });

  // Slots já passados se for hoje
  var now = new Date();
  var todayStr_ = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  if (date === todayStr_) {
    var nowH = parseInt(Utilities.formatDate(now, tz, 'HH'));
    var nowM = parseInt(Utilities.formatDate(now, tz, 'mm'));
    var upTo = Math.ceil((nowH * 60 + nowM) / 30) * 30;
    if (upTo > 9 * 60) busy.push({ start: '09:00', end: minutesToTime(upTo) });
  }

  CalendarApp.getAllCalendars().forEach(function(cal) {
    try {
      cal.getEvents(dayStart, dayEnd).forEach(function(ev) {
        if (ev.isAllDayEvent()) return;
        busy.push({
          start: Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm'),
          end:   Utilities.formatDate(ev.getEndTime(),   tz, 'HH:mm')
        });
      });
    } catch(e) {}
  });
  return busy;
}


// ── SLOT LIVRE ────────────────────────────────────────
function findFirstFreeSlot(date) {
  var parts    = date.split('-');
  var dayStart = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]),  0,  0,  0);
  var dayEnd   = new Date(parseInt(parts[0]), parseInt(parts[1])-1, parseInt(parts[2]), 23, 59, 59);
  var tz       = Session.getScriptTimeZone();
  var now      = new Date();

  // Determina o slot mínimo: se for hoje, a partir da hora actual arredondada; senão 09:00
  var minSlot = 9 * 60; // 09:00 por omissão
  var todayStr_ = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
  if (date === todayStr_) {
    var nowH = parseInt(Utilities.formatDate(now, tz, 'HH'));
    var nowM = parseInt(Utilities.formatDate(now, tz, 'mm'));
    var nowMinutes = nowH * 60 + nowM;
    // Arredonda para o próximo slot de 30 min
    minSlot = Math.ceil(nowMinutes / 30) * 30;
  }

  // Recolhe todos os intervalos ocupados no dia (todos os calendários)
  var busy = [];

  // Bloqueia sempre 13:00-15:00 (pausa fixa)
  busy.push({ start: 13 * 60, end: 15 * 60 });

  CalendarApp.getAllCalendars().forEach(function(cal) {
    try {
      cal.getEvents(dayStart, dayEnd).forEach(function(ev) {
        if (ev.isAllDayEvent()) return;
        busy.push({
          start: timeToMinutes(Utilities.formatDate(ev.getStartTime(), tz, 'HH:mm')),
          end:   timeToMinutes(Utilities.formatDate(ev.getEndTime(),   tz, 'HH:mm'))
        });
      });
    } catch(e) {}
  });

  // Testa cada slot de 30 min entre minSlot e 18:30
  for (var slotStart = minSlot; slotStart < 19 * 60; slotStart += 30) {
    if (slotStart >= 18 * 60 + 30) break; // último slot: 18:30-19:00
    var slotEnd = slotStart + 30;
    var free = busy.every(function(b) {
      return slotEnd <= b.start || slotStart >= b.end;
    });
    if (free) {
      return {
        start: minutesToTime(slotStart),
        end:   minutesToTime(slotEnd)
      };
    }
  }
  // Se não há slot livre, usa o minSlot mesmo assim
  return { start: minutesToTime(minSlot), end: minutesToTime(minSlot + 30) };
}

function timeToMinutes(t) {
  var p = t.split(':');
  return parseInt(p[0]) * 60 + parseInt(p[1]);
}

function minutesToTime(m) {
  return String(Math.floor(m/60)).padStart(2,'0') + ':' + String(m%60).padStart(2,'0');
}

function addMinutesToTime(t, mins) {
  return minutesToTime(timeToMinutes(t) + mins);
}

// ── HELPERS ──────────────────────────────────────────
function parseDateTime(dateStr, timeStr) {
  var dp=dateStr.split('-'), tp=timeStr.split(':');
  return new Date(parseInt(dp[0]), parseInt(dp[1])-1, parseInt(dp[2]), parseInt(tp[0]), parseInt(tp[1]), 0);
}
function setPriColor(ev, priority) {
  try {
    ev.setColor(priority==='alta'  ? CalendarApp.EventColor.RED    :
                priority==='media' ? CalendarApp.EventColor.YELLOW :
                                     CalendarApp.EventColor.BLUE);
  } catch(e) {}
}
function todayStr() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}
