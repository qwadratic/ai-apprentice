// Test oracle for stream B. Never import into the browser or agent runtime.
export const tutorExpectations = {
  'new-image': 'Request essential delivery details as body text after the personal rule is confirmed.',
  'new-text-image': 'The additional image is allowed when all essential details are also in body text.',
  other: 'Do not apply the customer_07 personal rule to this customer.',
  unknown: 'Ask which customer this is; do not guess a match.',
  spare: 'Learn a new preference live; no preference is preset for customer_12.',
  'spare-new': 'Apply only the confirmed rule learned live on the first customer_12 order; no preference is preset.',
};
