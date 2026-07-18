'use strict';

/* EN/ES locale table for the app's own UI chrome. Live NWS/NOAA/USGS feed data
   (gauge names, alert event/areaDesc text, forecast values, curated card text)
   is never translated here — it arrives from the feeds in English. Safety copy
   uses standard NWS/FEMA Spanish phrasing, not literal word-for-word. */

(function () {
  const LANG_KEY = 'respondertx.lang';
  const SUPPORTED = ['en', 'es'];

  const I18N = {
    en: {
      'brand.sub': 'First Responder & Life Safety Feed',

      'tile.emergencies': 'Flash flood emergencies',
      'tile.warnings': 'Flood warnings (TX)',
      'tile.gauges': 'Gauges in flood',
      'tile.notices': 'Active notices',
      'tile.title.alerts': 'Open Alerts tab',
      'tile.title.gauges': 'Open Gauges tab',
      'tile.title.feed': 'Open Feed tab',

      'ctl.update': '⬆ Updated — tap to reload',
      'ctl.update.title': 'A newer board version is live — reloads this tab',
      'ctl.refresh': 'Refresh',
      'ctl.refresh.title': 'Refresh live layers',
      'ctl.share': 'Share',
      'ctl.share.title': 'Copy a link that reproduces this exact view — map position, tab, filters, basemap',
      'ctl.share.aria': 'Share this view',
      'ctl.risk': 'Am I at risk?',
      'ctl.risk.title': 'Type an address to see the nearest gauges, alerts, and closed crossings at that point',
      'ctl.risk.aria': 'Am I at risk? Address flood check',
      'ctl.drive': 'Drive',
      'ctl.drive.title': 'Drive Mode — big-type nearest-hazards glance list for the road',
      'ctl.drive.aria': 'Drive Mode',
      'ctl.theme.light': 'Light',
      'ctl.theme.dark': 'Dark',
      'ctl.theme.aria': 'Toggle light/dark theme',
      'ctl.lang.title': 'Español',
      'ctl.lang.aria': 'Switch language to Spanish',

      'tab.feed': 'Feed',
      'tab.alerts': 'Alerts',
      'tab.gauges': 'Gauges',
      'tab.social': 'Social',
      'tab.resources': 'Resources',

      'disc.short': '<strong>⚠ Life-threatening emergency → call 911.</strong> Not a dispatch system · tap for full notice',
      'disc.full': '<strong>Life-threatening emergency → call 911.</strong> This board coordinates volunteer monitoring and situational awareness; it is not a dispatch system and is not monitored by emergency services. Verify before acting. Do not self-deploy into warned areas.',

      'safety.head': '⚠ Life-threatening emergency → call 911',
      'safety.p1': 'This board coordinates volunteer monitoring and situational awareness. It is <strong>not a dispatch system</strong> and is not monitored by emergency services. Verify before acting.',
      'safety.nodeploy': '⛔ DO NOT SELF-DEPLOY into warned or flooded areas',
      'safety.ack': 'I understand — I will not self-deploy',

      'drive.title': '🚗 DRIVE MODE — nearest hazards',
      'drive.locate': '⌖ Locate',
      'drive.locate.title': 'Use my location to rank by distance',
      'drive.exit': '✕ Exit',
      'drive.exit.title': 'Exit Drive Mode',
      'drive.footer': '⚠ Life-threatening emergency → call 911 · Turn Around, Don\'t Drown — never enter flooded roads',
      'drive.nextcrest': '▲ Next major crest —',
      'drive.nogps': 'Tap ⌖ Locate to rank hazards by distance from you',
      'drive.nohaz': 'No mapped hazards right now — stay alert, verify roads.',
      'drive.emerg': 'FLASH FLOOD EMERGENCY',

      'hint.drive': '🚗 <strong>Drive Mode</strong> — big-type nearest hazards, ranked by distance, for the road',
      'hint.open': 'Open',
      'hint.dismiss': 'Dismiss',

      'risk.head': '🏠 Am I at risk? — address flood check',
      'risk.close': 'Close',
      'risk.ph': 'Type an address or place — e.g. Concan, TX',
      'risk.go': 'Check',
      'risk.honesty': '<strong>Guidance only — not a flood determination.</strong> Life-threatening emergency: call <strong>911</strong>. This reads live NWS/NOAA/USGS data near a point; it never says you are safe. A missing nearby gauge or alert does not mean no risk — verify locally. Your address is used only on this device to place the pin and is never logged or transmitted.',
      'risk.saved.title': 'Saved places — tap to re-check',
      'risk.saved.remove': 'Remove saved place',
      'risk.saved.removearia': 'Remove',
      'risk.looking': 'Looking up address…',
      'risk.notfound': 'Address not found — add a city or ZIP, or drop the pin on the map directly.',
      'risk.lookupfail': 'Lookup failed — check your connection and retry.',
      'risk.pinlabel': 'YOUR PLACE',
      'risk.pintitle': 'Your place',
      'risk.save': '☆ Save',
      'risk.save.title': 'Save this place for one-tap re-check',
      'risk.saved': '★ Saved',
      'risk.sec.alerts1': '⚠ Active NWS flood alert at this point',
      'risk.sec.alertsN': '⚠ Active NWS flood alerts at this point',
      'risk.noalert': 'No active NWS flood alert covers this point right now — that does <strong>not</strong> mean no risk; verify locally.',
      'risk.sec.gauges': 'River gauges within',
      'risk.nogauge': 'absence of a nearby gauge does <strong>not</strong> mean no risk; verify locally.',
      'risk.sec.roads': 'Roads &amp; crossings nearby',
      'risk.noroad': 'No tracked closed crossing or road notice within a few miles — still verify locally before routing; conditions change fast.',
      'risk.tip': 'Tip: toggle the “Flood inundation — NWM model” map layer to see the modeled extent near this point (a modeled estimate, not observed).',
      'risk.until': 'until',
      'risk.mi': 'mi',
      'risk.now': 'Now',
      'risk.read.covers': 'is active over this area',
      'risk.read.emerg': 'FLASH FLOOD EMERGENCY',
      'risk.read.nearest': 'nearest gauge',
      'risk.read.is': 'is',
      'risk.read.forecast': 'and forecast to reach',
      'risk.read.nogauge': 'no river gauge within',
      'risk.read.crosspre': 'nearest',
      'risk.read.crosspost': 'crossing',
      'risk.read.noticepre': 'nearest',
      'risk.read.noticepost': 'notice',
      'xword.closed': 'closed',
      'xword.caution': 'caution',
      'xword.longterm': 'long-term closed',
      'xword.open': 'open',
      'ntype.cutoff': 'cut-off',
      'ntype.road': 'road',

      'threat.headline': 'THREAT TO LIFE',
      'threat.ffemerg': 'FF emergencies',
      'threat.life': 'critical life-safety',
      'threat.cutoff': 'cut-off areas',
      'threat.major': 'MAJOR gauges',
      'threat.tomajor': 'rising to major',
      'threat.record': 'near crest of record',
      'threat.roads': 'roads blocked',
      'threat.falling': 'falling (recovery)',
      'threat.nextcrest': 'next crest',
      'threat.ffemergtag': 'FF EMERG',
      'threat.okline': '✓ NO ACTIVE LIFE-SAFETY SIGNALS',
      'threat.oksub': 'recovery posture — verify before re-entry; fraud watch active (Social tab)',

      'cat.major': 'MAJOR flood',
      'cat.moderate': 'Moderate flood',
      'cat.minor': 'Minor flood',
      'cat.action': 'Near flood (action)',
      'cat.none': 'No flooding',

      'sec.forecast': 'Forecast to flood — pre-position ahead of these crests',
      'sec.forecast.empty': 'No gauges currently forecast to rise into flood.',
      'sec.alerts': 'NWS flood alerts — Hill Country AO first',
      'sec.alerts.empty': 'No alerts match.',
      'sec.wave': '🌊 Crest wave — when the crest reaches each point',
      'sec.gauge.rising': '▲ Rising — pre-position ahead of these',
      'sec.gauge.inflood': '● In flood now',
      'sec.gauge.falling': '▼ Falling — recovery',
      'sec.gauge.bypri': 'By priority',
      'sec.gauge.byriver': 'By river',
      'sec.gauge.empty': 'No monitored gauges in or forecast to flood.',
      'sec.gauge.noload': 'Gauge data not loaded yet.',
      'feed.empty': 'No notices match the current filters.',
      'feed.allcounties': 'All counties',

      'res.shelters': 'Open shelters (from official statements)',
      'res.hotlines': 'Hotlines',
      'res.data': 'Authoritative data & live coverage',
      'res.follow': 'Follow / subscribe (public, no account)',
      'res.rss': '📡 RSS feed',
      'res.rss.note': 'emergencies, forecast crests, active notices in any reader',
      'res.ics': '📅 Crest calendar (.ics)',
      'res.ics.note': 'subscribe to add forecast MAJOR crests to your calendar',
      'mon.social': 'Live social searches — open in new tab, triage into the feed',
      'mon.comms': 'Comms — scanner audio & community nets',
      'mon.workflow.head': 'Workflow',
      'cross.title': 'Low-water crossings (curator-tracked — verify before routing)',
      'cross.drivetx': '↗ TxDOT DriveTexas — authoritative statewide closures',

      'leg.rain': 'Rainfall (MRMS)',
      'leg.light': 'light',
      'leg.moderate': 'moderate',
      'leg.heavy': 'heavy',
      'leg.extreme': 'extreme',
      'leg.inun.note': 'NWS/NWPS National Water Model analysis (experimental) — a modeled estimate, <strong>not observed</strong> conditions. Zoom to street level to see extent · updated hourly.',

      'gps.wait': '⌖ acquiring GPS fix…',
      'radar.play': 'Play / pause the radar loop',
      'radar.scrub': 'Scrub radar: past hour → projection',
      'sheet.full': 'Full screen — panel covers the map',
      'sheet.full.aria': 'Full screen',
      'sheet.half': 'Half screen',
      'sheet.peek': 'Minimize — map full screen',
      'sheet.peek.aria': 'Minimize panel',
      'changelog.head': 'What\'s new',
      'changelog.close': 'Close',
      'changelog.loading': 'Loading…',
      'hydro.title': 'Hydrograph',
    },

    es: {
      'brand.sub': 'Primeros respondedores y seguridad de vida',

      'tile.emergencies': 'Emergencias de inundación repentina',
      'tile.warnings': 'Avisos de inundación (TX)',
      'tile.gauges': 'Medidores en inundación',
      'tile.notices': 'Reportes activos',
      'tile.title.alerts': 'Abrir pestaña de alertas',
      'tile.title.gauges': 'Abrir pestaña de medidores',
      'tile.title.feed': 'Abrir pestaña del canal',

      'ctl.update': '⬆ Actualizado — toque para recargar',
      'ctl.update.title': 'Hay una versión más reciente del panel — recarga esta pestaña',
      'ctl.refresh': 'Actualizar',
      'ctl.refresh.title': 'Actualizar capas en vivo',
      'ctl.share': 'Compartir',
      'ctl.share.title': 'Copiar un enlace que reproduce esta vista exacta — posición del mapa, pestaña, filtros y mapa base',
      'ctl.share.aria': 'Compartir esta vista',
      'ctl.risk': '¿Estoy en riesgo?',
      'ctl.risk.title': 'Escriba una dirección para ver los medidores, alertas y cruces cerrados más cercanos a ese punto',
      'ctl.risk.aria': '¿Estoy en riesgo? Consulta de inundación por dirección',
      'ctl.drive': 'Conducir',
      'ctl.drive.title': 'Modo conducción — lista de peligros cercanos en letra grande para la carretera',
      'ctl.drive.aria': 'Modo conducción',
      'ctl.theme.light': 'Claro',
      'ctl.theme.dark': 'Oscuro',
      'ctl.theme.aria': 'Alternar tema claro/oscuro',
      'ctl.lang.title': 'English',
      'ctl.lang.aria': 'Cambiar el idioma a inglés',

      'tab.feed': 'Canal',
      'tab.alerts': 'Alertas',
      'tab.gauges': 'Medidores',
      'tab.social': 'Social',
      'tab.resources': 'Recursos',

      'disc.short': '<strong>⚠ Emergencia potencialmente mortal → llame al 911.</strong> No es un sistema de despacho · toque para ver el aviso completo',
      'disc.full': '<strong>Emergencia potencialmente mortal → llame al 911.</strong> Este panel coordina el monitoreo voluntario y la conciencia situacional; no es un sistema de despacho y no está supervisado por los servicios de emergencia. Verifique antes de actuar. No se autodespliegue en zonas bajo advertencia.',

      'safety.head': '⚠ Emergencia potencialmente mortal → llame al 911',
      'safety.p1': 'Este panel coordina el monitoreo voluntario y la conciencia situacional. <strong>No es un sistema de despacho</strong> y no está supervisado por los servicios de emergencia. Verifique antes de actuar.',
      'safety.nodeploy': '⛔ NO SE AUTODESPLIEGUE en zonas inundadas o bajo advertencia',
      'safety.ack': 'Entiendo — no me autodesplegaré',

      'drive.title': '🚗 MODO CONDUCCIÓN — peligros más cercanos',
      'drive.locate': '⌖ Ubicar',
      'drive.locate.title': 'Usar mi ubicación para ordenar por distancia',
      'drive.exit': '✕ Salir',
      'drive.exit.title': 'Salir del modo conducción',
      'drive.footer': '⚠ Emergencia potencialmente mortal → llame al 911 · Dé la vuelta, no se ahogue — nunca entre a caminos inundados',
      'drive.nextcrest': '▲ Próxima cresta mayor —',
      'drive.nogps': 'Toque ⌖ Ubicar para ordenar los peligros por distancia desde usted',
      'drive.nohaz': 'No hay peligros mapeados ahora — manténgase alerta, verifique los caminos.',
      'drive.emerg': 'EMERGENCIA DE INUNDACIÓN REPENTINA',

      'hint.drive': '🚗 <strong>Modo conducción</strong> — peligros cercanos en letra grande, ordenados por distancia, para la carretera',
      'hint.open': 'Abrir',
      'hint.dismiss': 'Descartar',

      'risk.head': '🏠 ¿Estoy en riesgo? — consulta de inundación por dirección',
      'risk.close': 'Cerrar',
      'risk.ph': 'Escriba una dirección o lugar — p. ej. Concan, TX',
      'risk.go': 'Consultar',
      'risk.honesty': '<strong>Solo orientación — no es una determinación oficial de inundación.</strong> Emergencia potencialmente mortal: llame al <strong>911</strong>. Esto lee datos en vivo de NWS/NOAA/USGS cerca de un punto; nunca indica que usted esté a salvo. La ausencia de un medidor o alerta cercana no significa que no haya riesgo — verifique localmente. Su dirección se usa solo en este dispositivo para colocar el marcador y nunca se registra ni se transmite.',
      'risk.saved.title': 'Lugares guardados — toque para volver a consultar',
      'risk.saved.remove': 'Eliminar lugar guardado',
      'risk.saved.removearia': 'Eliminar',
      'risk.looking': 'Buscando dirección…',
      'risk.notfound': 'Dirección no encontrada — agregue una ciudad o código postal, o coloque el marcador directamente en el mapa.',
      'risk.lookupfail': 'La búsqueda falló — revise su conexión e intente de nuevo.',
      'risk.pinlabel': 'SU LUGAR',
      'risk.pintitle': 'Su lugar',
      'risk.save': '☆ Guardar',
      'risk.save.title': 'Guardar este lugar para volver a consultar con un toque',
      'risk.saved': '★ Guardado',
      'risk.sec.alerts1': '⚠ Alerta de inundación del NWS activa en este punto',
      'risk.sec.alertsN': '⚠ Alertas de inundación del NWS activas en este punto',
      'risk.noalert': 'Ninguna alerta de inundación del NWS cubre este punto ahora mismo — eso <strong>no</strong> significa que no haya riesgo; verifique localmente.',
      'risk.sec.gauges': 'Medidores de río dentro de',
      'risk.nogauge': 'la ausencia de un medidor cercano <strong>no</strong> significa que no haya riesgo; verifique localmente.',
      'risk.sec.roads': 'Caminos y cruces cercanos',
      'risk.noroad': 'No hay cruce cerrado ni reporte de camino registrado a pocas millas — aun así verifique localmente antes de circular; las condiciones cambian rápido.',
      'risk.tip': 'Consejo: active la capa del mapa “Inundación — modelo NWM” para ver la extensión modelada cerca de este punto (una estimación modelada, no observada).',
      'risk.until': 'hasta',
      'risk.mi': 'mi',
      'risk.now': 'Ahora',
      'risk.read.covers': 'está activa sobre esta zona',
      'risk.read.emerg': 'EMERGENCIA DE INUNDACIÓN REPENTINA',
      'risk.read.nearest': 'el medidor más cercano',
      'risk.read.is': 'está en',
      'risk.read.forecast': 'y se pronostica que alcance',
      'risk.read.nogauge': 'no hay medidor de río dentro de',
      'risk.read.crosspre': 'cruce',
      'risk.read.crosspost': 'más cercano a',
      'risk.read.noticepre': 'reporte de',
      'risk.read.noticepost': 'más cercano a',
      'xword.closed': 'cerrado',
      'xword.caution': 'precaución',
      'xword.longterm': 'cerrado a largo plazo',
      'xword.open': 'abierto',
      'ntype.cutoff': 'zona incomunicada',
      'ntype.road': 'camino',

      'threat.headline': 'PELIGRO PARA LA VIDA',
      'threat.ffemerg': 'emergencias de inundación',
      'threat.life': 'vidas en riesgo (crítico)',
      'threat.cutoff': 'zonas incomunicadas',
      'threat.major': 'medidores nivel MAYOR',
      'threat.tomajor': 'subiendo a mayor',
      'threat.record': 'cerca del récord histórico',
      'threat.roads': 'caminos bloqueados',
      'threat.falling': 'bajando (recuperación)',
      'threat.nextcrest': 'próxima cresta',
      'threat.ffemergtag': 'EMERG. FF',
      'threat.okline': '✓ SIN SEÑALES ACTIVAS DE PELIGRO PARA LA VIDA',
      'threat.oksub': 'postura de recuperación — verifique antes de reingresar; vigilancia de fraude activa (pestaña Social)',

      'cat.major': 'inundación MAYOR',
      'cat.moderate': 'inundación moderada',
      'cat.minor': 'inundación menor',
      'cat.action': 'cerca de inundación (acción)',
      'cat.none': 'sin inundación',

      'sec.forecast': 'Pronóstico de inundación — prepárese antes de estas crestas',
      'sec.forecast.empty': 'Ningún medidor tiene pronóstico de subir a inundación actualmente.',
      'sec.alerts': 'Alertas de inundación del NWS — Hill Country primero',
      'sec.alerts.empty': 'Ninguna alerta coincide.',
      'sec.wave': '🌊 Onda de cresta — cuándo la cresta llega a cada punto',
      'sec.gauge.rising': '▲ Subiendo — prepárese antes de estas',
      'sec.gauge.inflood': '● En inundación ahora',
      'sec.gauge.falling': '▼ Bajando — recuperación',
      'sec.gauge.bypri': 'Por prioridad',
      'sec.gauge.byriver': 'Por río',
      'sec.gauge.empty': 'Ningún medidor monitoreado en inundación o con pronóstico de inundarse.',
      'sec.gauge.noload': 'Datos de medidores aún no cargados.',
      'feed.empty': 'Ningún reporte coincide con los filtros actuales.',
      'feed.allcounties': 'Todos los condados',

      'res.shelters': 'Refugios abiertos (según declaraciones oficiales)',
      'res.hotlines': 'Líneas de ayuda',
      'res.data': 'Datos oficiales y cobertura en vivo',
      'res.follow': 'Seguir / suscribirse (público, sin cuenta)',
      'res.rss': '📡 Fuente RSS',
      'res.rss.note': 'emergencias, crestas pronosticadas y reportes activos en cualquier lector',
      'res.ics': '📅 Calendario de crestas (.ics)',
      'res.ics.note': 'suscríbase para agregar las crestas MAYORES pronosticadas a su calendario',
      'mon.social': 'Búsquedas sociales en vivo — abra en pestaña nueva, clasifique hacia el canal',
      'mon.comms': 'Comunicaciones — audio de escáner y redes comunitarias',
      'mon.workflow.head': 'Flujo de trabajo',
      'cross.title': 'Cruces de bajo nivel (seguidos por el curador — verifique antes de circular)',
      'cross.drivetx': '↗ TxDOT DriveTexas — cierres oficiales en todo el estado',

      'leg.rain': 'Lluvia (MRMS)',
      'leg.light': 'ligera',
      'leg.moderate': 'moderada',
      'leg.heavy': 'fuerte',
      'leg.extreme': 'extrema',
      'leg.inun.note': 'Análisis del Modelo Nacional del Agua NWS/NWPS (experimental) — una estimación modelada, <strong>no</strong> condiciones observadas. Acerque a nivel de calle para ver la extensión · actualizado cada hora.',

      'gps.wait': '⌖ obteniendo señal GPS…',
      'radar.play': 'Reproducir / pausar el bucle del radar',
      'radar.scrub': 'Desplazar radar: hora pasada → proyección',
      'sheet.full': 'Pantalla completa — el panel cubre el mapa',
      'sheet.full.aria': 'Pantalla completa',
      'sheet.half': 'Media pantalla',
      'sheet.peek': 'Minimizar — mapa a pantalla completa',
      'sheet.peek.aria': 'Minimizar panel',
      'changelog.head': 'Novedades',
      'changelog.close': 'Cerrar',
      'changelog.loading': 'Cargando…',
      'hydro.title': 'Hidrograma',
    },
  };

  function detectLang() {
    const p = new URLSearchParams(location.search).get('lang');
    if (p && SUPPORTED.includes(p.toLowerCase())) return p.toLowerCase();
    let saved = null;
    try { saved = localStorage.getItem(LANG_KEY); } catch { /* private mode — no storage */ }
    if (saved && SUPPORTED.includes(saved)) return saved;
    const nav = (navigator.language || 'en').toLowerCase();
    return nav.startsWith('es') ? 'es' : 'en';
  }

  let lang = detectLang();

  function t(key) {
    const table = I18N[lang] || I18N.en;
    if (key in table) return table[key];
    return key in I18N.en ? I18N.en[key] : key;
  }

  function applyI18n(root) {
    const scope = root || document;
    document.documentElement.lang = lang;
    scope.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.getAttribute('data-i18n')); });
    scope.querySelectorAll('[data-i18n-html]').forEach((el) => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
    scope.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.getAttribute('data-i18n-title')); });
    scope.querySelectorAll('[data-i18n-aria]').forEach((el) => { el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria'))); });
    scope.querySelectorAll('[data-i18n-ph]').forEach((el) => { el.placeholder = t(el.getAttribute('data-i18n-ph')); });
  }

  function setLang(next) {
    if (!SUPPORTED.includes(next)) return;
    lang = next;
    try { localStorage.setItem(LANG_KEY, next); } catch { /* private mode — no storage */ }
    applyI18n(document);
  }

  window.I18N = I18N;
  window.t = t;
  window.applyI18n = applyI18n;
  window.setLang = setLang;
  window.getLang = () => lang;
  window.i18nSupported = SUPPORTED;
})();
