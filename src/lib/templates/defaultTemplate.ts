/** HTML of the one bundled template, Shipping Label 4x6. */
export const DEFAULT_TEMPLATE_HTML = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body class="p-4 text-xs font-sans">
  <!-- Label border -->
  <div class="border-4 border-slate-800 rounded-lg p-3 h-full flex flex-col justify-between">
    <div class="space-y-2">
      <div class="flex justify-between items-center border-b border-slate-300 pb-2">
        <span class="text-[10px] uppercase tracking-widest text-slate-500">PrintNinja Logistics</span>
        <span class="text-[10px] font-mono text-slate-600">Order #{{order.id}}</span>
      </div>

      <div class="grid grid-cols-2 gap-3">
        <div class="bg-slate-100 rounded p-2">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">From</p>
          <p class="text-[11px] font-medium">{{store.name}}</p>
          <p class="text-[10px] text-slate-600">{{store.address}}</p>
        </div>
        <div class="bg-slate-50 rounded p-2">
          <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">To</p>
          <p class="text-[11px] font-bold">{{customer.name}}</p>
          <p class="text-[10px] text-slate-700">{{customer.address}}</p>
          <p class="text-[10px] text-slate-700">{{customer.city}} {{customer.zip}}</p>
          <p class="text-[10px] font-semibold text-slate-900">{{customer.country}}</p>
        </div>
      </div>

      <div class="bg-slate-100 rounded p-2">
        <p class="text-[9px] uppercase tracking-wider font-semibold text-slate-500 mb-1">Contents</p>
        <p class="text-[10px] text-slate-700">
          {{#each order.items}}{{name}} (×{{qty}}){{#unless @last}}, {{/unless}}{{/each}}
        </p>
      </div>
    </div>

    <div class="border-t border-slate-300 pt-2 text-center">
      {{barcode "code128" order.tracking width=70 text=false}}
      <p class="font-mono text-base font-bold tracking-widest">{{order.tracking}}</p>
      <p class="text-[9px] text-slate-400 mt-1">Tracking number</p>
    </div>
  </div>
</body>
</html>`;

export const DEFAULT_TEMPLATE_CSS = `@page { margin: 0; }
* { box-sizing: border-box; }
body { margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact; }`;

export const DEFAULT_MOCK_DATA = {
  store: {
    name: "PrintNinja Cafe",
    address: "123 Main Street, Dhaka",
    email: "hello@printninja.app",
  },
  customer: {
    name: "John Doe",
    address: "45 Oak Lane, Apt 2",
    city: "Gulshan",
    zip: "1212",
    country: "Bangladesh",
    email: "john@example.com",
  },
  order: {
    id: "1042",
    date: "Oct 17, 2026",
    due: "Nov 16, 2026",
    customer: "Walk-in",
    cashier: "Aisha",
    terminal: "T1",
    tracking: "PN-7X9K-4242-BD",
    items: [
      { name: "Green Tea (Medium)", qty: 2, price: 3.5, total: 7.0 },
      { name: "Latte (Large)", qty: 1, price: 4.5, total: 4.5 },
      { name: "Croissant (Butter)", qty: 1, price: 3.0, total: 3.0 },
      { name: "Blueberry Muffin", qty: 2, price: 3.25, total: 6.5 },
    ],
    subtotal: 21.0,
    tax: 2.1,
    discount: 1.5,
    total: 21.6,
    payment: {
      method: "Credit Card",
      ref: "VISA ···· 4242",
    },
  },
};

// The single bundled starter template, seeded on first run and shown in the
// Designer's template list. It is also the Designer's fallback when the
// database is empty or the app runs without a backend.
export const STARTER_TEMPLATES = [
  {
    name: "Shipping Label 4x6",
    page_w_mm: 102,
    page_h_mm: 152,
    orientation: "portrait" as const,
    html: DEFAULT_TEMPLATE_HTML,
    css: DEFAULT_TEMPLATE_CSS,
  },
];
