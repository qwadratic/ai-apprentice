// Northwind Mail, a digital twin for the Clipa demo: a small mail client in plain HTML, CSS and JavaScript.
// - No framework, no network, nothing stored (no cookies, no browser storage): a reload starts again from the URL.
// - All people, companies, addresses and numbers are synthetic. Send is simulated: it shows a toast and sends nothing.
// - Cases: ?case=a (invoice to Lumen Bakery, Net 14), b (invoice to North Pier, Net 14), c (delivery update to customer_07, image
//   only, empty message) or d (blank). Without ?case the inbox opens. The "Twin case" menu in the top bar switches case too.
(function () {
  'use strict';

  // ---- synthetic data -----------------------------------------------------------------------------------------------
  var CASES = [
    {
      id: 'a', label: '(a) Invoice · Lumen Bakery',
      to: 'billing@lumen-bakery.example', subject: 'Invoice INV-2231',
      body: 'Hello Lumen Bakery team,\n\nPlease find attached invoice INV-2231 for October (EUR 1,480.00).\n\nPayment terms: Net 14.',
      attachments: [{ name: 'INV-2231.pdf', size: '84 KB', kind: 'pdf' }],
    },
    {
      id: 'b', label: '(b) Invoice · North Pier',
      to: 'billing@north-pier.example', subject: 'Invoice INV-2232',
      body: 'Hello North Pier team,\n\nPlease find attached invoice INV-2232 for October (EUR 960.00).\n\nPayment terms: Net 14.',
      attachments: [{ name: 'INV-2232.pdf', size: '81 KB', kind: 'pdf' }],
    },
    {
      id: 'c', label: '(c) Delivery update · customer_07',
      to: 'customer_07', subject: 'Delivery update — ORD-2063', body: '',
      attachments: [{ name: 'delivery-summary.png', size: '212 KB', kind: 'image' }],
    },
    { id: 'd', label: '(d) Blank compose', to: '', subject: '', body: '', attachments: [] },
  ];

  var ALIASES = {
    a: 'a', b: 'b', c: 'c', d: 'd', lumen: 'a', 'lumen-bakery': 'a', northpier: 'b', 'north-pier': 'b',
    customer_07: 'c', customer07: 'c', delivery: 'c', blank: 'd', empty: 'd', new: 'd',
  };

  var INBOX = [
    {
      id: 'm1', from: 'Lumen Bakery', address: 'billing@lumen-bakery.example', subject: 'Re: October invoice', time: '09:12', unread: true, replyCase: 'a',
      body: 'Hello,\n\nCould you send us the invoice for October when it is ready?\n\nThank you,\nLumen Bakery accounts',
    },
    {
      id: 'm2', from: 'North Pier Café', address: 'billing@north-pier.example', subject: 'Invoice for the October delivery?', time: '08:47', unread: true, replyCase: 'b',
      body: 'Hi,\n\nWe have not seen the invoice for the October delivery yet. Could you send it over?\n\nBest,\nNorth Pier Café',
    },
    {
      id: 'm3', from: 'Dispatch (internal)', address: 'dispatch@northwind.example', subject: 'Delivery update needed: ORD-2063', time: '08:31', unread: true, replyCase: 'c',
      body: 'Please send the delivery update for order ORD-2063 to customer_07. The delivery summary image is ready.\n\nDispatch',
    },
    {
      id: 'm4', from: 'Facilities', address: 'facilities@northwind.example', subject: 'Fire drill on Thursday', time: 'Yesterday', unread: false, replyCase: null,
      body: 'Hello all,\n\nThere is a fire drill on Thursday at 11:00. Please leave by the nearest exit and meet at the car park.\n\nFacilities',
    },
    {
      id: 'm5', from: 'Weekly digest', address: 'digest@northwind.example', subject: 'Your week at a glance', time: 'Yesterday', unread: false, replyCase: null,
      body: 'Three meetings, two deadlines, one holiday. Have a good week.',
    },
    {
      id: 'm6', from: 'People team', address: 'people@northwind.example', subject: 'Holiday calendar 2027', time: 'Mon', unread: false, replyCase: null,
      body: 'The holiday calendar for 2027 is now on the intranet. Please check your team days before you book.\n\nPeople team',
    },
  ];

  var DELIVERY_CARD = [
    ['Order', 'ORD-2063'], ['Customer', 'customer_07'], ['Address', '9 Sample Row, 1010 Exampletown'], ['Delivery window', '2026-10-14, 09:00-11:00'],
  ];

  // ---- state (in memory only) ---------------------------------------------------------------------------------------
  var state = {
    folder: 'inbox',
    view: 'list',
    selectedId: null,
    caseId: null,
    draft: null,
    sent: [],
    sentSeq: 0,
    search: '',
    toastTimer: null,
    returnFocus: null,
  };

  var $ = function (id) { return document.getElementById(id); };
  var app = $('app');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    Object.keys(props || {}).forEach(function (key) {
      var value = props[key];
      if (key === 'text') node.textContent = value;
      else if (key === 'class') node.className = value;
      else if (key.slice(0, 2) === 'on') node.addEventListener(key.slice(2), value);
      else if (value === true) node.setAttribute(key, '');
      else if (value !== false && value !== null && value !== undefined) node.setAttribute(key, String(value));
    });
    (children || []).forEach(function (child) { if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child); });
    return node;
  }

  function caseById(id) { return CASES.filter(function (c) { return c.id === id; })[0] || null; }

  function cloneDraft(c) {
    return { to: c.to, subject: c.subject, body: c.body, attachments: c.attachments.map(function (a) { return { name: a.name, size: a.size, kind: a.kind }; }), original: c.attachments.map(function (a) { return { name: a.name, size: a.size, kind: a.kind }; }) };
  }

  // ---- folders and the list ----------------------------------------------------------------------------------------
  function listFor(folder) {
    if (folder === 'inbox') return INBOX.map(function (m) { return { id: m.id, from: m.from, subject: m.subject, snippet: m.body.replace(/\s+/g, ' '), time: m.time, unread: m.unread }; });
    if (folder === 'sent') {
      return state.sent.map(function (m) { return { id: m.id, from: 'To: ' + (m.to || '(no recipient)'), subject: m.subject || '(no subject)', snippet: m.body.replace(/\s+/g, ' ') || '(no message)', time: 'just now', unread: false }; });
    }
    if (folder === 'drafts' && state.draft) {
      return [{ id: 'draft', from: 'Draft', subject: state.draft.subject || '(no subject)', snippet: state.draft.body.replace(/\s+/g, ' ') || '(no message)', time: 'now', unread: false }];
    }
    return [];
  }

  function renderFolders() {
    Array.prototype.forEach.call(document.querySelectorAll('.folder'), function (button) {
      var folder = button.getAttribute('data-folder');
      button.setAttribute('aria-current', state.view === 'list' && state.folder === folder ? 'true' : 'false');
    });
    var unread = INBOX.filter(function (m) { return m.unread; }).length;
    $('count-inbox').textContent = unread ? String(unread) : '';
    $('count-drafts').textContent = state.draft ? '1' : '';
    $('count-sent').textContent = state.sent.length ? String(state.sent.length) : '';
  }

  function renderList() {
    var folder = state.folder;
    var title = folder === 'inbox' ? 'Inbox' : folder === 'sent' ? 'Sent' : 'Drafts';
    $('list-title').textContent = title;
    var query = state.search.trim().toLowerCase();
    var items = listFor(folder).filter(function (m) {
      return query === '' || (m.from + ' ' + m.subject + ' ' + m.snippet).toLowerCase().indexOf(query) >= 0;
    });
    var list = $('messages');
    list.textContent = '';
    if (items.length === 0) {
      list.appendChild(el('li', { class: 'empty', text: query ? 'No message matches your search.' : folder === 'inbox' ? 'Nothing here.' : 'No messages in ' + title + '.' }));
    }
    items.forEach(function (m) {
      var button = el('button', {
        type: 'button', class: 'message' + (m.unread ? ' message--unread' : ''), 'data-message': m.id, 'aria-current': String(state.selectedId === m.id),
        onclick: function () { state.selectedId = m.id; renderList(); renderReader(); },
      }, [
        el('div', { class: 'message__row' }, [el('span', { class: 'message__from', text: m.from }), el('span', { class: 'message__time', text: m.time })]),
        el('div', { class: 'message__subject', text: m.subject }),
        el('div', { class: 'message__snippet', text: m.snippet }),
      ]);
      list.appendChild(el('li', {}, [button]));
    });
  }

  function attachmentLine(attachments) {
    return attachments.length ? 'Attachments: ' + attachments.map(function (a) { return a.name + ' (' + a.size + ')'; }).join(', ') : 'No attachments';
  }

  function renderReader() {
    var reader = $('reader');
    reader.textContent = '';
    var id = state.selectedId;
    var card;
    var inbox = state.folder === 'inbox' ? INBOX.filter(function (m) { return m.id === id; })[0] : null;
    var sent = state.folder === 'sent' ? state.sent.filter(function (m) { return m.id === id; })[0] : null;
    if (inbox) {
      card = el('div', { class: 'reader__card' }, [
        el('h2', { class: 'reader__subject', text: inbox.subject }),
        el('p', { class: 'reader__meta' }, [el('strong', { text: inbox.from }), ' <' + inbox.address + '> · ' + inbox.time]),
        el('p', { class: 'reader__body', text: inbox.body }),
        el('div', { class: 'reader__actions' }, [
          inbox.replyCase ? el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'reply', text: 'Reply', onclick: function () { openCase(inbox.replyCase); } }) : null,
        ]),
      ]);
    } else if (sent) {
      card = el('div', { class: 'reader__card' }, [
        el('h2', { class: 'reader__subject', text: sent.subject || '(no subject)' }),
        el('p', { class: 'reader__meta' }, [el('strong', { text: 'To: ' + (sent.to || '(no recipient)') }), ' · just now ', el('span', { class: 'badge', text: 'Sent (simulated)' })]),
        el('p', { class: 'reader__body', text: sent.body || '(no message)' }),
        el('p', { class: 'reader__attach', text: attachmentLine(sent.attachments) }),
      ]);
    } else if (state.folder === 'drafts' && state.draft && id === 'draft') {
      card = el('div', { class: 'reader__card' }, [
        el('h2', { class: 'reader__subject', text: state.draft.subject || '(no subject)' }),
        el('p', { class: 'reader__meta' }, [el('strong', { text: 'To: ' + (state.draft.to || '(no recipient)') }), ' · draft']),
        el('p', { class: 'reader__body', text: state.draft.body || '(no message)' }),
        el('p', { class: 'reader__attach', text: attachmentLine(state.draft.attachments) }),
        el('div', { class: 'reader__actions' }, [el('button', { type: 'button', class: 'btn btn--primary', 'data-action': 'continue', text: 'Continue editing', onclick: showCompose })]),
      ]);
    } else {
      card = el('div', { class: 'reader__card' }, [el('p', { class: 'reader__body', text: 'Select a message to read it.' })]);
    }
    reader.appendChild(card);
  }

  // ---- views --------------------------------------------------------------------------------------------------------
  function setTitle(text) { document.title = text ? text + ' · Northwind Mail' : 'Northwind Mail'; }

  function syncCaseSelect() { $('case-select').value = state.view === 'compose' && state.caseId ? state.caseId : ''; }

  function showList(folder) {
    state.view = 'list';
    state.folder = folder;
    if (folder === 'inbox' && !INBOX.some(function (m) { return m.id === state.selectedId; })) state.selectedId = INBOX[0].id;
    if (folder === 'sent' && state.sent.length && !state.sent.some(function (m) { return m.id === state.selectedId; })) state.selectedId = state.sent[state.sent.length - 1].id;
    if (folder === 'drafts') state.selectedId = state.draft ? 'draft' : null;
    app.setAttribute('data-view', 'list');
    $('view-list').hidden = false;
    $('view-compose').hidden = true;
    renderFolders();
    renderList();
    renderReader();
    syncCaseSelect();
    setTitle(folder === 'inbox' ? 'Inbox' : folder === 'sent' ? 'Sent' : 'Drafts');
  }

  function renderChips() {
    var chips = $('chips');
    chips.textContent = '';
    state.draft.attachments.forEach(function (a, index) {
      var isImage = a.kind === 'image';
      var name = isImage
        ? el('button', { type: 'button', class: 'chip__name chip__name--link', 'data-action': 'open-image', text: a.name, title: 'Look at the image', onclick: function (e) { openImage(a, e.currentTarget); } })
        : el('span', { class: 'chip__name', text: a.name });
      chips.appendChild(el('li', { class: 'chip', 'data-attachment': a.name }, [
        el('span', { class: 'chip__icon', 'aria-hidden': 'true', text: isImage ? 'PNG' : 'PDF' }),
        name,
        el('span', { class: 'chip__size', text: a.size }),
        el('button', {
          type: 'button', class: 'chip__remove', 'data-action': 'remove-attachment', 'aria-label': 'Remove attachment ' + a.name, title: 'Remove',
          onclick: function () { state.draft.attachments.splice(index, 1); renderChips(); },
        }, ['×']),
      ]));
    });
  }

  function fillDraftFields() {
    $('field-to').value = state.draft.to;
    $('field-subject').value = state.draft.subject;
    $('field-body').value = state.draft.body;
    $('compose-title').textContent = state.draft.subject ? 'Draft: ' + state.draft.subject : 'New message';
    renderChips();
  }

  function showCompose() {
    if (!state.draft) state.draft = cloneDraft(caseById('d'));
    state.view = 'compose';
    app.setAttribute('data-view', 'compose');
    $('view-list').hidden = true;
    $('view-compose').hidden = false;
    fillDraftFields();
    renderFolders();
    syncCaseSelect();
    setTitle('Compose' + (state.draft.subject ? ': ' + state.draft.subject : ''));
  }

  function openCase(id) {
    var c = caseById(id);
    if (!c) return;
    closeOverlays();
    state.caseId = c.id;
    state.draft = cloneDraft(c);
    showCompose();
  }

  // ---- overlays, send and the toast -----------------------------------------------------------------------------------
  function openOverlay(id, focusId, from) {
    state.returnFocus = from || document.activeElement;
    $(id).hidden = false;
    $(focusId).focus();
  }

  function closeOverlays() {
    var open = !$('overlay-preview').hidden || !$('overlay-image').hidden;
    $('overlay-preview').hidden = true;
    $('overlay-image').hidden = true;
    if (open && state.returnFocus && state.returnFocus.focus && document.contains(state.returnFocus)) state.returnFocus.focus();
    state.returnFocus = null;
  }

  function openPreview() {
    $('preview-to').textContent = state.draft.to || '(no recipient)';
    $('preview-subject').textContent = state.draft.subject || '(no subject)';
    $('preview-body').textContent = state.draft.body || '(no message)';
    $('preview-attach').textContent = attachmentLine(state.draft.attachments);
    openOverlay('overlay-preview', 'preview-send', $('preview'));
  }

  function openImage(attachment, from) {
    $('image-title').textContent = attachment.name;
    var picture = $('picture');
    picture.textContent = '';
    picture.appendChild(el('p', { class: 'picture__brand', text: 'Northwind deliveries' }));
    picture.appendChild(el('h3', { class: 'picture__title', text: 'Delivery summary' }));
    picture.appendChild(el('dl', { class: 'picture__rows' }, DELIVERY_CARD.map(function (row) {
      return el('div', {}, [el('dt', { text: row[0] }), el('dd', { text: row[1] })]);
    })));
    openOverlay('overlay-image', 'image-close', from);
  }

  function showToast(text) {
    var toast = $('toast');
    toast.textContent = text;
    toast.hidden = false;
    if (state.toastTimer) clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(function () { toast.hidden = true; state.toastTimer = null; }, 4200);
  }

  function send() {
    if (!state.draft) return;
    closeOverlays();
    state.sentSeq += 1;
    state.sent.push({ id: 'sent-' + state.sentSeq, to: state.draft.to, subject: state.draft.subject, body: state.draft.body, attachments: state.draft.attachments.slice() });
    state.selectedId = 'sent-' + state.sentSeq;
    state.draft = null;
    state.caseId = null;
    showList('sent');
    showToast('Sent (simulated)');
  }

  function discard() {
    closeOverlays();
    state.draft = null;
    state.caseId = null;
    showList('inbox');
  }

  // ---- wiring ---------------------------------------------------------------------------------------------------------
  function init() {
    var select = $('case-select');
    select.appendChild(el('option', { value: '', text: 'Inbox (no case)' }));
    CASES.forEach(function (c) { select.appendChild(el('option', { value: c.id, text: c.label })); });
    select.addEventListener('change', function () { if (select.value === '') { state.draft = null; state.caseId = null; showList('inbox'); } else openCase(select.value); });

    Array.prototype.forEach.call(document.querySelectorAll('.folder'), function (button) {
      button.addEventListener('click', function () { closeOverlays(); showList(button.getAttribute('data-folder')); });
    });
    $('brand').addEventListener('click', function (e) { e.preventDefault(); closeOverlays(); showList('inbox'); });
    $('compose-new').addEventListener('click', function () { closeOverlays(); state.caseId = 'd'; state.draft = cloneDraft(caseById('d')); showCompose(); $('field-to').focus(); });
    $('search').addEventListener('input', function (e) { state.search = e.target.value; if (state.view === 'list') { renderList(); } });

    $('field-to').addEventListener('input', function (e) { state.draft.to = e.target.value; });
    $('field-subject').addEventListener('input', function (e) { state.draft.subject = e.target.value; $('compose-title').textContent = e.target.value ? 'Draft: ' + e.target.value : 'New message'; setTitle('Compose' + (e.target.value ? ': ' + e.target.value : '')); renderFolders(); });
    $('field-body').addEventListener('input', function (e) { state.draft.body = e.target.value; });
    $('attach-add').addEventListener('click', function () {
      var back = state.draft.original.filter(function (o) { return !state.draft.attachments.some(function (a) { return a.name === o.name; }); })[0];
      state.draft.attachments.push(back ? { name: back.name, size: back.size, kind: back.kind } : { name: 'scan-' + (state.draft.attachments.length + 1) + '.png', size: '96 KB', kind: 'image' });
      renderChips();
    });
    $('preview').addEventListener('click', openPreview);
    $('send').addEventListener('click', send);
    $('discard').addEventListener('click', discard);
    $('preview-send').addEventListener('click', send);
    $('preview-back').addEventListener('click', closeOverlays);
    $('image-close').addEventListener('click', closeOverlays);
    ['overlay-preview', 'overlay-image'].forEach(function (id) {
      $(id).addEventListener('click', function (e) { if (e.target === $(id)) closeOverlays(); });
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeOverlays(); });

    var requested = new URLSearchParams(window.location.search).get('case');
    var wanted = requested ? ALIASES[requested.trim().toLowerCase()] : null;
    if (wanted) openCase(wanted); else showList('inbox');
  }

  // A read-only view of what the page shows, for the recording script (it describes the screen from the real DOM).
  window.northwindTwin = {
    cases: CASES.map(function (c) { return c.id; }),
    open: openCase,
    snapshot: function () {
      return {
        view: state.view,
        folder: state.folder,
        caseId: state.caseId,
        to: state.draft ? state.draft.to : null,
        subject: state.draft ? state.draft.subject : null,
        body: state.draft ? state.draft.body : null,
        attachments: state.draft ? state.draft.attachments.map(function (a) { return a.name; }) : [],
        previewOpen: !$('overlay-preview').hidden,
        sentCount: state.sent.length,
      };
    },
  };

  init();
})();
