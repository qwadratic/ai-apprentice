import type { WorkspaceController, WorkspaceState } from './workspace.ts';
import type { WorkspaceSurface } from './activity.ts';

/** Scoped UI component. The app shell owns its lifecycle. */
export function mountDemoWorkspace(container: HTMLElement, workspace: WorkspaceController) {
  const root = container.ownerDocument.createElement('section');
  root.className = 'demo-workspace';
  root.setAttribute('aria-label', 'Demonstration workspace');
  root.innerHTML = `
    <header class="dw-header"><div><p class="dw-eyebrow">AI Apprentice · synthetic workspace</p><h2>Order → email → ticket</h2></div>
      <div class="dw-controls"><label>Demo case<select data-field="case"></select></label><button type="button" data-action="reset">Reset task</button></div></header>
    <p class="dw-notice">All data is fictional. Send only simulates an email. Preview is built into this sandbox; it does not intercept clicks in other apps. Reset task preserves agent knowledge.</p>
    <p class="dw-notice" data-view="off-record" role="status" hidden>Workspace is off record. Checks and input activity are paused.</p>
    <div class="dw-grid">
      <article class="dw-card" data-surface="order"><p class="dw-eyebrow">1 · source order</p><h3 data-view="order-title"></h3>
        <label>Customer<input data-field="order-customer" placeholder="Unknown customer" autocomplete="off"></label>
        <label>Items<input data-field="items" autocomplete="off"></label>
        <label>Delivery address<input data-field="address" autocomplete="off"></label>
        <label>Delivery window<input data-field="window" autocomplete="off"></label>
        <p class="dw-muted">Copy the details you need into your message.</p>
      </article>
      <article class="dw-card" data-surface="email"><p class="dw-eyebrow">2 · compose email</p><h3>Delivery update</h3><p class="dw-muted" data-view="email-phase"></p>
        <label>Recipient customer<input data-field="recipient" placeholder="Unknown customer" autocomplete="off"></label>
        <label>Subject<input data-field="subject" autocomplete="off"></label>
        <label>Message<textarea data-field="body" rows="8"></textarea></label>
        <h4>Image attachments</h4><div data-view="attachments"></div>
        <button type="button" data-action="attach">Attach case delivery image</button>
        <div class="dw-check" data-view="check-panel"><strong data-view="check-title"></strong><p role="status" aria-live="polite" data-view="check-message"></p><p class="dw-muted" data-view="evidence"></p></div>
        <label class="dw-ack" data-view="ack-panel" hidden><input type="checkbox" data-field="ack">I have reviewed the warning or uncertainty and choose to send this demo email.</label>
        <div class="dw-actions"><button type="button" class="dw-primary" data-action="preview">Preview & check</button><button type="button" data-action="send">Send demo email</button></div>
        <p class="dw-muted" data-view="sent" role="status"></p>
      </article>
      <article class="dw-card dw-ticket" data-surface="ticket"><p class="dw-eyebrow">3 · record outcome</p><h3>Task ticket</h3><p data-view="ticket-identity"></p>
        <p data-view="ticket-status"></p><label>Work summary<textarea data-field="ticket" rows="4"></textarea></label>
        <button type="button" data-action="resolve">Mark resolved</button>
      </article>
    </div>`;
  container.append(root);
  function element<T extends HTMLElement>(selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing workspace element: ${selector}`);
    return found;
  }
  const field = (name: string) => element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[data-field="${name}"]`);
  const view = (name: string) => element<HTMLElement>(`[data-view="${name}"]`);
  const button = (name: string) => element<HTMLButtonElement>(`[data-action="${name}"]`);
  const cases = workspace.getCases();
  for (const item of cases) {
    const option = root.ownerDocument.createElement('option'); option.value = item.id; option.textContent = item.label;
    field('case').append(option);
  }
  function value(name: string, text: string) { if (field(name).value !== text) field(name).value = text; }
  let attachmentSignature = '';
  function render(state: WorkspaceState) {
    value('case', state.caseId);
    value('order-customer', state.order.customerRef ?? ''); value('items', state.order.items);
    value('address', state.order.deliveryAddress); value('window', state.order.deliveryWindow);
    value('recipient', state.draft.customerRef ?? ''); value('subject', state.draft.subject); value('body', state.draft.body);
    value('ticket', state.ticket.summary); view('order-title').textContent = state.order.id;
    const signature = JSON.stringify(state.draft.attachments);
    if (signature !== attachmentSignature) {
      attachmentSignature = signature; view('attachments').replaceChildren();
      for (const attachment of state.draft.attachments) {
        const figure = root.ownerDocument.createElement('figure');
        const image = root.ownerDocument.createElement('img'); image.src = attachment.imageUrl; image.alt = 'Attached delivery summary image';
        const caption = root.ownerDocument.createElement('figcaption'); caption.textContent = attachment.name;
        const remove = root.ownerDocument.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove image';
        remove.addEventListener('click', () => workspace.editDraft({ attachments: workspace.getState().draft.attachments.filter(item => item.id !== attachment.id) }));
        figure.append(image, caption, remove); view('attachments').append(figure);
      }
      if (!state.draft.attachments.length) view('attachments').textContent = 'No attachments.';
    }
    const titles = { idle: 'Preview required', pending: 'Checking…', clear: 'Clear', warn: 'Warning', unknown: 'Unknown', error: 'Check failed' };
    view('check-panel').dataset.status = state.check.status; view('check-title').textContent = titles[state.check.status];
    view('check-message').textContent = state.check.status === 'idle' ? 'Check the current draft before sending. Any change requires a new Preview.'
      : state.check.status === 'pending' ? 'Waiting for current screen observations and the agent response. You can still edit; edits cancel this check.' : state.check.message;
    view('evidence').textContent = 'evidenceIds' in state.check && state.check.evidenceIds.length ? `Evidence: ${state.check.evidenceIds.join(', ')}` : '';
    view('ack-panel').hidden = !['warn', 'unknown'].includes(state.check.status) || !!state.sent;
    element<HTMLInputElement>('[data-field="ack"]').checked = state.acknowledged;
    button('preview').disabled = state.offRecord || state.check.status === 'pending' || !!state.sent;
    button('send').disabled = !workspace.canSend(); button('attach').disabled = !!state.sent || !!state.draft.attachments.length;
    for (const name of ['order-customer', 'items', 'address', 'window', 'recipient', 'subject', 'body']) field(name).disabled = !!state.sent;
    for (const remove of view('attachments').querySelectorAll('button')) remove.disabled = !!state.sent;
    view('sent').textContent = state.sent ? 'Demo email sent locally. No real email was sent.' : '';
    view('off-record').hidden = !state.offRecord;
    view('email-phase').textContent = state.sent ? 'Sent in demo' : state.check.status === 'idle' ? 'Editing' : 'Preview';
    view('ticket-identity').textContent = `Ticket TKT-${state.order.id} · Order ${state.order.id} · Customer ${state.order.customerRef ?? 'Unknown'}`;
    view('ticket-status').textContent = state.ticket.status === 'resolved' ? 'Done · simulated workflow completed' : state.sent ? 'Open · demo email sent, record the outcome' : 'Open · email not sent';
    button('resolve').disabled = !state.sent || state.ticket.status === 'resolved';
  }
  field('case').addEventListener('change', () => workspace.reset(field('case').value));
  button('reset').addEventListener('click', () => workspace.reset());
  for (const [name, property] of [['order-customer', 'customerRef'], ['items', 'items'], ['address', 'deliveryAddress'], ['window', 'deliveryWindow']] as const) {
    field(name).addEventListener('input', () => workspace.editOrder({ [property]: name === 'order-customer' ? field(name).value || null : field(name).value }));
  }
  for (const [name, property] of [['recipient', 'customerRef'], ['subject', 'subject'], ['body', 'body']] as const) {
    field(name).addEventListener('input', () => workspace.editDraft({ [property]: name === 'recipient' ? field(name).value || null : field(name).value }));
  }
  field('ticket').addEventListener('input', () => workspace.editTicket(field('ticket').value));
  field('ack').addEventListener('change', () => workspace.acknowledgeRisk(element<HTMLInputElement>('[data-field="ack"]').checked));
  button('attach').addEventListener('click', () => workspace.editDraft({ attachments: structuredClone(cases.find(item => item.id === workspace.getState().caseId)!.draft.attachments) }));
  button('preview').addEventListener('click', () => { void workspace.preview(); });
  button('send').addEventListener('click', () => { workspace.send(); });
  button('resolve').addEventListener('click', () => { workspace.resolveTicket(); });
  root.addEventListener('input', event => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) || target.type === 'checkbox') return;
    const surface = target.closest('[data-surface]')?.getAttribute('data-surface');
    if (surface === 'order' || surface === 'email' || surface === 'ticket') workspace.inputActivity(surface as WorkspaceSurface);
  });
  const unsubscribe = workspace.subscribe(render);
  return () => { unsubscribe(); root.remove(); };
}
