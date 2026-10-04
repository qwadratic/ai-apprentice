export type Attachment = { id: string; name: string; imageUrl: string };
export type DemoCase = {
  id: string;
  label: string;
  order: { id: string; customerRef: string | null; deliveryAddress: string; deliveryWindow: string; items: string };
  draft: { customerRef: string | null; subject: string; body: string; attachments: Attachment[] };
};

function deliveryImage(orderId: string, address: string, window: string): Attachment {
  // Visible artwork only: no OCR text, rationale or personal rule is attached to this asset.
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="660" height="180" viewBox="0 0 660 180"><rect width="660" height="180" rx="12" fill="#f0f7f5"/><g fill="#183d35" font-family="sans-serif"><text x="24" y="40" font-size="22">Delivery summary · ${orderId}</text><text x="24" y="84" font-size="20">${address}</text><text x="24" y="122" font-size="20">${window}</text><text x="24" y="156" font-size="14">Synthetic demonstration data</text></g></svg>`;
  return { id: `${orderId}-image`, name: `${orderId}-delivery.svg`, imageUrl: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` };
}

function makeCase(id: string, label: string, orderId: string, customerRef: string | null, address: string, window: string, fullText = false): DemoCase {
  return {
    id, label,
    order: { id: orderId, customerRef, deliveryAddress: address, deliveryWindow: window, items: '2 sample desk lamps' },
    draft: {
      customerRef, subject: `Delivery update — ${orderId}`,
      body: fullText ? `Hello,\n\nYour delivery is scheduled for ${window}.\nDelivery address: ${address}.\n\nKind regards,\nDemo operations` : 'Hello,\n\nPlease see the attached delivery summary.\n\nKind regards,\nDemo operations',
      attachments: [deliveryImage(orderId, address, window)],
    },
  };
}

// Neutral labels and runtime data. Tutor expectations live in tests/ only.
export const demoCases: readonly DemoCase[] = [
  makeCase('practice', 'Practice order · customer_07', 'ORD-2041', 'customer_07', '14 Sample Lane, 1010 Exampletown', '2026-10-12 14:00-16:00'),
  makeCase('new-image', 'New order · customer_07 · attachment', 'ORD-2057', 'customer_07', '82 Sample Walk, 1010 Exampletown', '2026-10-13 09:00-11:00'),
  makeCase('new-text-image', 'New order · customer_07 · text and attachment', 'ORD-2057', 'customer_07', '82 Sample Walk, 1010 Exampletown', '2026-10-13 09:00-11:00', true),
  makeCase('other', 'Order · customer_03', 'DEMO-3001', 'customer_03', '9 Amber Avenue, Sample City', '7 Oct 2026, 10:00–12:00'),
  makeCase('unknown', 'Order · unidentified customer', 'DEMO-U001', null, '31 Cloud Court, Sample City', '8 Oct 2026, 15:00–17:00'),
  makeCase('spare', 'First order · customer_12', 'DEMO-1201', 'customer_12', '55 Meadow Mews, Sample City', '9 Oct 2026, 08:00–10:00'),
  makeCase('spare-new', 'Second order · customer_12', 'DEMO-1202', 'customer_12', '27 Finch Field, Sample City', '10 Oct 2026, 13:00–15:00'),
];
