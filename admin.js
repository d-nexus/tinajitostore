/* TinajitoStore — PANEL ADMINISTRATIVO (requiere app.js cargado antes) */
/* ==========================================
   MÓDULO: PANEL ADMINISTRATIVO INTEGRAL
   ========================================== */
let editingProductId = null;
let editingAffiliateId = null;
let lastAdminAffiliates = [];
let productSuppliers = {}; // { [product_id]: {nombre, telefono} } — SOLO se llena dentro del panel admin, nunca se mezcla con `products` (que sí se cachea/muestra en la tienda pública).

function initAdminView() {
    switchAdminTab('dashboard');
}

function switchAdminTab(tabName) {
    document.querySelectorAll('.admin-tab-content').forEach(el => el.classList.add('hidden'));
    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.classList.remove('bg-indigo-600', 'text-white', 'shadow-md');
        btn.classList.add('bg-slate-900', 'text-slate-300', 'border', 'border-slate-800', 'hover:bg-slate-800');
    });

    document.getElementById(`admin-tab-${tabName}`).classList.remove('hidden');
    const activeBtn = document.querySelector(`.admin-tab-btn[data-tab="${tabName}"]`);
    if (activeBtn) {
        activeBtn.classList.remove('bg-slate-900', 'text-slate-300', 'border', 'border-slate-800', 'hover:bg-slate-800');
        activeBtn.classList.add('bg-indigo-600', 'text-white', 'shadow-md');
    }

    if (tabName === 'dashboard') renderAdminDashboard();
    if (tabName === 'products') renderAdminProducts();
    if (tabName === 'categories') renderAdminCategories();
    if (tabName === 'affiliates') renderAdminAffiliates();
}

// --- 1. REPORTE DE VENTAS Y COMISIONES ---
const estadoDe = s => s.estado || 'confirmada'; // compatibilidad si aún no corriste la migración v3

// Moneda de una venta: los pedidos en USD llevan el sufijo "-USD" en su referencia
// (o la columna "moneda", si existe). Sin sufijo = pesos (CUP).
function saleCurrency(s) {
    return (s && (s.moneda === 'USD' || /-USD$/i.test(String(s.order_ref || '')))) ? 'USD' : 'CUP';
}

// Trae TODAS las ventas (Supabase entrega máx. 1000 por petición, así que se pagina).
async function fetchAllSales() {
    const rows = [];
    const PAGE = 1000;
    for (let from = 0; ; from += PAGE) {
        const { data, error } = await supabase.from('sales').select('*')
            .order('fecha', { ascending: false }).order('id', { ascending: false })
            .range(from, from + PAGE - 1);
        if (error) throw error;
        rows.push(...(data || []));
        if (!data || data.length < PAGE) break;
    }
    return rows;
}

// El dashboard muestra UNA moneda a la vez (nunca mezcla pesos con dólares).
let dashCurrency = 'CUP';

function ensureDashCurrencyToggle() {
    const tab = document.getElementById('admin-tab-dashboard');
    if (!tab || document.getElementById('dash-currency-toggle')) return;
    const box = document.createElement('div');
    box.id = 'dash-currency-toggle';
    box.className = 'flex flex-wrap items-center gap-3';
    box.innerHTML = `
        <span class="text-xs font-bold text-slate-400 uppercase tracking-wider">Ver reportes en</span>
        <div class="flex gap-2">
            <button type="button" data-cur="CUP" class="dash-currency-btn px-4 py-2 rounded-xl text-xs font-bold">Pesos (CUP)</button>
            <button type="button" data-cur="USD" class="dash-currency-btn px-4 py-2 rounded-xl text-xs font-bold">Dólares (USD)</button>
        </div>
        <span class="text-[11px] text-slate-500">Cada moneda se suma por separado; nunca se mezclan.</span>`;
    tab.insertBefore(box, tab.firstChild);
    box.querySelectorAll('.dash-currency-btn').forEach(b => b.addEventListener('click', () => {
        dashCurrency = b.dataset.cur;
        renderDashboardFromHistory();
    }));
}

function paintDashCurrencyToggle() {
    document.querySelectorAll('.dash-currency-btn').forEach(b => {
        const active = b.dataset.cur === dashCurrency;
        b.classList.toggle('bg-indigo-600', active);
        b.classList.toggle('text-white', active);
        b.classList.toggle('bg-slate-800', !active);
        b.classList.toggle('text-slate-300', !active);
    });
}

async function renderAdminDashboard() {
    ensureDashCurrencyToggle();
    try {
        salesHistory = await fetchAllSales();
    } catch (error) {
        console.error('Error cargando ventas:', error.message || error);
        return;
    }
    renderDashboardFromHistory();
}

function renderDashboardFromHistory() {
    paintDashCurrencyToggle();
    const cur = dashCurrency;
    const inCur = salesHistory.filter(s => saleCurrency(s) === cur);

    // Solo las ventas CONFIRMADAS cuentan para totales y comisiones.
    const confirmed = inCur.filter(s => estadoDe(s) === 'confirmada');
    const pendingCount = salesHistory.filter(s => estadoDe(s) === 'pendiente').length;

    const totalRevenue = confirmed.reduce((acc, s) => acc + Number(s.monto_venta), 0);
    const totalCommissions = confirmed.reduce((acc, s) => acc + Number(s.comision_ganada), 0);
    const totalProfit = confirmed.reduce((acc, s) => acc + Number(s.ganancia || 0), 0);

    document.getElementById('stat-total-sales').textContent = confirmed.length;
    document.getElementById('stat-total-revenue').textContent = fmtMoney(totalRevenue, cur);
    document.getElementById('stat-total-commissions').textContent = fmtMoney(totalCommissions, cur);
    const profitEl = document.getElementById('stat-total-profit');
    if (profitEl) profitEl.textContent = fmtMoney(totalProfit, cur);
    const badge = document.getElementById('admin-pending-badge');
    if (badge) badge.textContent = pendingCount ? `${pendingCount} pendiente(s) por revisar` : '';

    // --- Resumen por afiliado (solo la moneda elegida) ---
    const statsByCode = {};
    inCur.forEach(s => {
        const st = estadoDe(s);
        if (st === 'cancelada' || !s.codigo) return; // sin código = venta directa, no va en la tabla de afiliados
        if (!statsByCode[s.codigo]) {
            statsByCode[s.codigo] = { nombre: s.nombre, count: 0, pending: 0, revenue: 0, commission: 0, unpaid: 0, profit: 0 };
        }
        const item = statsByCode[s.codigo];
        if (st === 'pendiente') { item.pending += 1; return; }
        item.count += 1;
        item.revenue += Number(s.monto_venta);
        item.commission += Number(s.comision_ganada);
        item.profit += Number(s.ganancia || 0);
        if (!s.comision_pagada) item.unpaid += Number(s.comision_ganada);
    });

    const tableBody = document.getElementById('sales-report-table');
    const keys = Object.keys(statsByCode);

    if (keys.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="9" class="px-6 py-10 text-center text-slate-500">No hay ventas en ${cur} con códigos de afiliados aún.</td></tr>`;
    } else {
        tableBody.innerHTML = keys.map(code => {
            const item = statsByCode[code];
            const payBtn = item.unpaid > 0
                ? `<button onclick="adminPayAffiliate('${escapeHtml(code)}','${cur}')" class="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold">Pagar todo</button>`
                : `<span class="text-xs text-slate-500">Al día</span>`;
            return `
                <tr class="hover:bg-slate-800/50 transition-colors">
                    <td class="px-6 py-4 font-mono font-bold text-white">${escapeHtml(code)}</td>
                    <td class="px-6 py-4 text-slate-300 font-medium">${escapeHtml(item.nombre)}</td>
                    <td class="px-6 py-4 text-slate-400 text-center">${item.count}</td>
                    <td class="px-6 py-4 text-amber-400 text-center font-bold">${item.pending}</td>
                    <td class="px-6 py-4 text-white font-bold">${fmtMoney(item.revenue, cur)}</td>
                    <td class="px-6 py-4 text-indigo-400 font-extrabold">${fmtMoney(item.commission, cur)}</td>
                    <td class="px-6 py-4 text-amber-400 font-extrabold">${fmtMoney(item.unpaid, cur)}</td>
                    <td class="px-6 py-4 text-emerald-400 font-extrabold">${fmtMoney(item.profit, cur)}</td>
                    <td class="px-6 py-4 text-right">${payBtn}</td>
                </tr>
            `;
        }).join('');
    }

    renderAdminSalesList();
    renderPeriodReport();
}

// --- Lista de ventas con acciones (confirmar / cancelar / pagar) ---
function renderAdminSalesList() {
    const tbody = document.getElementById('admin-sales-list');
    if (!tbody) return;
    if (salesHistory.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="px-6 py-10 text-center text-slate-500">Aún no hay ventas.</td></tr>`;
        return;
    }
    const badges = {
        pendiente: 'bg-amber-500/10 text-amber-400',
        confirmada: 'bg-emerald-500/10 text-emerald-400',
        cancelada: 'bg-rose-500/10 text-rose-400'
    };
    const btn = (label, fn, color) => `<button onclick="${fn}" class="px-2.5 py-1 rounded-lg ${color} text-xs font-bold">${label}</button>`;
    // Pendientes primero, luego el resto por fecha; máximo 50 filas.
    const rows = [...salesHistory]
        .sort((x, y) => (estadoDe(x) === 'pendiente' ? 0 : 1) - (estadoDe(y) === 'pendiente' ? 0 : 1))
        .slice(0, 50);

    tbody.innerHTML = rows.map(s => {
        const st = estadoDe(s);
        const id = Number(s.id);
        let actions = '';
        if (st === 'pendiente') {
            actions = btn('Confirmar', `adminSetSaleStatus(${id},'confirmada')`, 'bg-emerald-600 hover:bg-emerald-500 text-white')
                    + ' ' + btn('Cancelar', `adminSetSaleStatus(${id},'cancelada')`, 'bg-rose-600 hover:bg-rose-500 text-white');
        } else if (st === 'confirmada' && !s.codigo) {
            actions = btn('Cancelar', `adminSetSaleStatus(${id},'cancelada')`, 'bg-rose-600 hover:bg-rose-500 text-white');
        } else if (st === 'confirmada') {
            actions = (s.comision_pagada
                ? btn('Deshacer pago', `adminSetCommissionPaid(${id},false)`, 'bg-slate-700 hover:bg-slate-600 text-slate-200')
                : btn('Marcar pagada', `adminSetCommissionPaid(${id},true)`, 'bg-indigo-600 hover:bg-indigo-500 text-white')
                  + ' ' + btn('Cancelar', `adminSetSaleStatus(${id},'cancelada')`, 'bg-rose-600 hover:bg-rose-500 text-white'));
        } else {
            actions = btn('Reabrir', `adminSetSaleStatus(${id},'pendiente')`, 'bg-slate-700 hover:bg-slate-600 text-slate-200');
        }
        const waBtn = buildClientWhatsAppUrl(s)
            ? ` <button onclick="contactClientWhatsApp(${id})" title="Escribir al cliente por WhatsApp" aria-label="Escribir al cliente por WhatsApp" class="px-2.5 py-1 rounded-lg bg-[#25D366] hover:bg-[#20ba5a] text-white text-xs font-bold">💬</button>`
            : '';
        actions = btn('Detalle', `openOrderDetail(${id})`, 'bg-slate-700 hover:bg-slate-600 text-slate-200') + waBtn + ' ' + actions;
        const label = st === 'confirmada' && s.comision_pagada ? 'Pagada' : st.charAt(0).toUpperCase() + st.slice(1);
        return `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="px-6 py-4"><span class="block font-bold text-white">#${id}</span><span class="block text-[11px] text-slate-400">${s.fecha ? new Date(s.fecha).toLocaleString() : ''}</span></td>
                <td class="px-6 py-4 font-mono font-bold ${s.codigo ? 'text-white' : 'text-slate-500'}">${s.codigo ? escapeHtml(s.codigo) : 'Directa'}</td>
                <td class="px-6 py-4 text-slate-300"><span class="block">${escapeHtml(s.cliente || 'Cliente General')}</span>${s.order_ref ? `<span class="block text-[11px] text-slate-500 font-mono">${escapeHtml(s.order_ref)}</span>` : ''}${saleField(s, 'telefono') ? `<span class="block text-[11px] text-slate-400">📱 ${escapeHtml(saleField(s, 'telefono'))}</span>` : ''}</td>
                <td class="px-6 py-4 text-white font-bold">${fmtMoney(s.monto_venta, saleCurrency(s))}</td>
                <td class="px-6 py-4 text-indigo-400 font-bold">${fmtMoney(s.comision_ganada, saleCurrency(s))}</td>
                <td class="px-6 py-4 text-center"><span class="${badges[st] || badges.pendiente} font-bold px-3 py-1 rounded-full text-xs">${label}</span></td>
                <td class="px-6 py-4 text-right whitespace-nowrap">${actions}</td>
            </tr>`;
    }).join('');
}

// --- DETALLE DE PEDIDO, WHATSAPP AL CLIENTE Y EXPORTACIÓN CSV ---
// Los datos del cliente (teléfono, dirección, pago) y los productos viven en la fila de
// "sales" y solo los ve el admin (RLS). El portal de afiliados NO los recibe.
const SALE_FIELD_ALIASES = {
    telefono: ['telefono', 'cliente_telefono', 'phone'],
    direccion: ['direccion', 'cliente_direccion', 'address'],
    pago: ['pago', 'metodo_pago', 'payment']
};
function saleField(s, key) {
    for (const k of (SALE_FIELD_ALIASES[key] || [key])) {
        if (s[k] !== undefined && s[k] !== null && String(s[k]).trim() !== '') return String(s[k]).trim();
    }
    return '';
}

// Deja solo dígitos en formato internacional para wa.me. Un número de 8 dígitos
// (móvil cubano escrito sin prefijo) recibe el 53. Devuelve '' si no parece un teléfono.
function normalizePhoneForWhatsApp(raw) {
    let d = String(raw || '').replace(/\D/g, '');
    if (d.startsWith('00')) d = d.slice(2);
    if (d.length === 8) d = '53' + d;
    return d.length >= 10 ? d : '';
}

// Productos del pedido, tolerante con los nombres de campo (items/productos/detalle...).
function getSaleItems(s) {
    let raw = s.items ?? s.productos ?? s.detalle ?? s.detalle_items ?? s.articulos ?? null;
    if (typeof raw === 'string') { try { raw = JSON.parse(raw); } catch (e) { raw = null; } }
    if (!Array.isArray(raw)) return [];
    return raw.map(it => {
        const pid = it.id ?? it.product_id ?? it.producto_id;
        const qty = Number(it.quantity ?? it.cantidad ?? it.qty ?? 1) || 1;
        const priceRaw = it.price ?? it.precio ?? it.precio_unitario ?? it.unit_price;
        const price = (priceRaw === undefined || priceRaw === null || priceRaw === '') ? null : Number(priceRaw);
        let name = it.name ?? it.nombre ?? it.producto ?? it.product_name ?? '';
        if (!name) {
            const p = products.find(x => x.id === pid);
            name = p ? p.name : `Producto #${pid ?? '?'}`;
        }
        return { name: String(name), qty, price: Number.isFinite(price) ? price : null };
    });
}

function buildClientWhatsAppUrl(s) {
    const phone = normalizePhoneForWhatsApp(saleField(s, 'telefono'));
    if (!phone) return '';
    const items = getSaleItems(s);
    const nombre = (s.cliente && s.cliente !== 'Cliente General') ? ` ${s.cliente}` : '';
    let msg = `Hola${nombre}, te escribimos de TinajitoStore por tu pedido${s.order_ref ? ` (Ref. ${s.order_ref})` : ''}.`;
    if (items.length) msg += '\n\n' + items.map(i => `• ${i.qty} x ${i.name}`).join('\n');
    msg += `\n\nTotal: ${fmtMoney(s.monto_venta, saleCurrency(s))}`;
    return `https://wa.me/${phone}?text=${encodeURIComponent(msg)}`;
}

window.contactClientWhatsApp = function (id) {
    const s = salesHistory.find(x => Number(x.id) === Number(id));
    const url = s ? buildClientWhatsAppUrl(s) : '';
    if (!url) { showToast('Este pedido no tiene un teléfono válido'); return; }
    window.open(url, '_blank', 'noopener');
};

window.openOrderDetail = function (id) {
    const s = salesHistory.find(x => Number(x.id) === Number(id));
    const modal = document.getElementById('order-detail-modal');
    if (!s || !modal) return;

    const st = estadoDe(s);
    const badges = {
        pendiente: 'bg-amber-500/10 text-amber-400',
        confirmada: 'bg-emerald-500/10 text-emerald-400',
        cancelada: 'bg-rose-500/10 text-rose-400'
    };
    const statusLabel = st === 'confirmada' && s.comision_pagada ? 'Comisión pagada' : st.charAt(0).toUpperCase() + st.slice(1);
    const cur = saleCurrency(s);
    const money = v => fmtMoney(v, cur);
    const dash = '<span class="text-slate-600">—</span>';
    const field = (label, value) => `
        <div>
            <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">${label}</p>
            <p class="text-sm text-white font-medium break-words">${value || dash}</p>
        </div>`;

    const phone = saleField(s, 'telefono');
    const address = saleField(s, 'direccion');
    const payment = saleField(s, 'pago');
    const items = getSaleItems(s);

    let itemsHtml;
    if (items.length === 0) {
        itemsHtml = `<p class="text-sm text-slate-500 bg-slate-950 border border-slate-800 rounded-xl px-4 py-3">Este pedido no tiene el detalle de productos guardado.</p>`;
    } else {
        const allPriced = items.every(i => i.price !== null);
        const itemsSubtotal = allPriced ? items.reduce((acc, i) => acc + i.price * i.qty, 0) : null;
        const discount = (itemsSubtotal !== null) ? itemsSubtotal - Number(s.monto_venta || 0) : 0;
        itemsHtml = `
            <div class="overflow-x-auto rounded-xl border border-slate-800">
                <table class="w-full text-left text-sm">
                    <thead>
                        <tr class="bg-slate-950 text-slate-400 uppercase text-[11px] font-bold tracking-wider">
                            <th class="px-4 py-2.5">Producto</th>
                            <th class="px-4 py-2.5 text-center">Cant.</th>
                            <th class="px-4 py-2.5 text-right">Precio</th>
                            <th class="px-4 py-2.5 text-right">Subtotal</th>
                        </tr>
                    </thead>
                    <tbody class="divide-y divide-slate-800">
                        ${items.map(i => `
                        <tr>
                            <td class="px-4 py-2.5 text-white font-medium">${escapeHtml(i.name)}</td>
                            <td class="px-4 py-2.5 text-center text-slate-300">${i.qty}</td>
                            <td class="px-4 py-2.5 text-right text-slate-300">${i.price !== null ? money(i.price) : dash}</td>
                            <td class="px-4 py-2.5 text-right text-white font-bold">${i.price !== null ? money(i.price * i.qty) : dash}</td>
                        </tr>`).join('')}
                    </tbody>
                </table>
            </div>
            ${discount > 0.005 ? `<p class="text-xs text-emerald-400 font-medium mt-2 text-right">Descuento aplicado: -${money(discount)}</p>` : ''}`;
    }

    document.getElementById('order-detail-body').innerHTML = `
        <div class="pr-10 mb-6">
            <div class="flex flex-wrap items-center gap-2">
                <h3 class="text-xl font-bold text-white">Pedido #${Number(s.id)}</h3>
                <span class="${badges[st] || badges.pendiente} font-bold px-3 py-1 rounded-full text-xs">${escapeHtml(statusLabel)}</span>
            </div>
            <p class="text-xs text-slate-400 mt-1">${s.fecha ? escapeHtml(new Date(s.fecha).toLocaleString()) : ''}${s.order_ref ? ` · <span class="font-mono">${escapeHtml(s.order_ref)}</span>` : ''}</p>
        </div>
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-4 mb-6">
            ${field('Cliente', escapeHtml(s.cliente || 'Cliente General'))}
            ${field('Teléfono', phone ? escapeHtml(phone) : '')}
            ${field('Dirección de entrega', address ? escapeHtml(address) : '')}
            ${field('Método de pago', payment ? escapeHtml(payment) : '')}
            ${field('Afiliado', s.codigo ? `<span class="font-mono">${escapeHtml(s.codigo)}</span>${s.nombre ? ' · ' + escapeHtml(s.nombre) : ''}` : 'Venta directa')}
        </div>
        <p class="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Productos</p>
        ${itemsHtml}
        <div class="mt-5 pt-4 border-t border-slate-800 space-y-1.5 text-sm">
            <div class="flex justify-between text-base font-bold text-white"><span>Total del pedido</span><span>${money(s.monto_venta)}</span></div>
            <div class="flex justify-between text-slate-400"><span>Comisión del afiliado</span><span class="text-indigo-400 font-semibold">${money(s.comision_ganada)}</span></div>
            <div class="flex justify-between text-slate-400"><span>Tu ganancia</span><span class="text-emerald-400 font-semibold">${money(s.ganancia)}</span></div>
        </div>`;

    const waBtn = document.getElementById('order-detail-wa-btn');
    const waUrl = buildClientWhatsAppUrl(s);
    if (waBtn) {
        if (waUrl) { waBtn.href = waUrl; waBtn.classList.remove('hidden'); }
        else { waBtn.removeAttribute('href'); waBtn.classList.add('hidden'); }
    }

    modal.classList.remove('hidden');
    modal.classList.add('flex');
};

window.closeOrderDetail = function () {
    const modal = document.getElementById('order-detail-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
};

// Excel en español usa ";" como separador de columnas y "," como decimal.
// Si tu Excel abre el archivo en una sola columna, cambia esto a ','.
const CSV_DELIMITER = ';';

// Texto: se protege contra "inyección de fórmulas" (=, +, -, @) y se entrecomilla si hace falta.
function csvText(v) {
    let t = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(t)) t = "'" + t;
    if (t.includes(CSV_DELIMITER) || /["\n\r]/.test(t)) t = '"' + t.replace(/"/g, '""') + '"';
    return t;
}
function csvNum(v) {
    const t = Number(v || 0).toFixed(2);
    return CSV_DELIMITER === ';' ? t.replace('.', ',') : t;
}
function csvDate(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    return d.toLocaleString('sv-SE', { timeZone: 'America/Havana' }); // AAAA-MM-DD HH:MM:SS, hora de Cuba
}

window.exportSalesCSV = async function () {
    const btn = document.getElementById('export-sales-csv-btn');
    const original = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Exportando…'; }
    try {
        // Se pide todo a la base (no solo las 50 filas visibles), en páginas de 1000.
        const rows = await fetchAllSales();
        if (rows.length === 0) { showToast('No hay ventas para exportar'); return; }

        const header = ['ID', 'Fecha', 'Referencia', 'Estado', 'Cliente', 'Teléfono', 'Dirección', 'Método de pago',
            'Productos', 'Código afiliado', 'Afiliado', 'Moneda', 'Monto venta', 'Comisión', 'Ganancia', 'Comisión pagada'];
        const lines = [header.map(csvText).join(CSV_DELIMITER)];

        rows.forEach(s => {
            const items = getSaleItems(s).map(i => `${i.qty}x ${i.name}`).join(' | ');
            lines.push([
                csvText(s.id),
                csvText(csvDate(s.fecha)),
                csvText(s.order_ref || ''),
                csvText(estadoDe(s)),
                csvText(s.cliente || 'Cliente General'),
                csvText(normalizePhoneForWhatsApp(saleField(s, 'telefono')) || saleField(s, 'telefono')),
                csvText(saleField(s, 'direccion')),
                csvText(saleField(s, 'pago')),
                csvText(items),
                csvText(s.codigo || ''),
                csvText(s.codigo ? (s.nombre || '') : ''),
                csvText(saleCurrency(s)),
                csvNum(s.monto_venta),
                csvNum(s.comision_ganada),
                csvNum(s.ganancia),
                csvText(s.codigo ? (s.comision_pagada ? 'Sí' : 'No') : '')
            ].join(CSV_DELIMITER));
        });

        // BOM UTF-8 para que Excel respete tildes y ñ.
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const stamp = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Havana' });
        const link = document.createElement('a');
        link.href = url;
        link.download = `ventas-tinajitostore-${stamp}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast(`Exportadas ${rows.length} venta(s) a CSV`);
    } catch (err) {
        console.error('Error al exportar ventas:', err);
        alert('No se pudo exportar: ' + (err.message || err));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = original; }
    }
};

// --- REPORTE DE INGRESOS POR DÍA / MES / AÑO ---
// Los números vienen agregados desde el servidor (admin_sales_report) en hora de Cuba.
// Solo las ventas CONFIRMADAS suman ingresos; las canceladas se muestran aparte.
let reportPeriod = 'dia';

window.setReportPeriod = function (period) {
    reportPeriod = period;
    document.querySelectorAll('.report-period-btn').forEach(b => {
        const active = b.dataset.period === period;
        b.classList.toggle('bg-indigo-600', active);
        b.classList.toggle('text-white', active);
        b.classList.toggle('bg-slate-800', !active);
        b.classList.toggle('text-slate-300', !active);
    });
    renderPeriodReport();
};

// Clave del periodo en hora de Cuba: 2026-09-29 / 2026-09 / 2026.
function periodKey(fecha, periodo) {
    const d = new Date(fecha);
    if (!fecha || isNaN(d)) return 'Sin fecha';
    const day = d.toLocaleDateString('sv-SE', { timeZone: 'America/Havana' }); // AAAA-MM-DD
    return periodo === 'anio' ? day.slice(0, 4) : periodo === 'mes' ? day.slice(0, 7) : day;
}

// Agrupa las ventas de UNA moneda por periodo. Solo las confirmadas suman dinero.
function buildPeriodRows(sales, cur, periodo) {
    const map = {};
    sales.forEach(s => {
        if (saleCurrency(s) !== cur) return;
        const key = periodKey(s.fecha, periodo);
        const r = map[key] || (map[key] = { periodo: key, pedidos: 0, confirmadas: 0, pendientes: 0, canceladas: 0, ingresos: 0, comisiones: 0, ganancia: 0 });
        const st = estadoDe(s);
        r.pedidos += 1;
        if (st === 'confirmada') {
            r.confirmadas += 1;
            r.ingresos += Number(s.monto_venta || 0);
            r.comisiones += Number(s.comision_ganada || 0);
            r.ganancia += Number(s.ganancia || 0);
        } else if (st === 'pendiente') r.pendientes += 1;
        else if (st === 'cancelada') r.canceladas += 1;
    });
    return Object.values(map).sort((x, y) => y.periodo.localeCompare(x.periodo));
}

function renderPeriodReport() {
    const tbody = document.getElementById('period-report-table');
    if (!tbody) return;
    const cur = dashCurrency;
    const rows = buildPeriodRows(salesHistory, cur, reportPeriod);
    if (rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-10 text-center text-slate-500">Aún no hay pedidos en ${cur}.</td></tr>`;
        return;
    }
    const m = v => fmtMoney(v, cur);
    tbody.innerHTML = rows.map(r => `
        <tr class="hover:bg-slate-800/50 transition-colors">
            <td class="px-6 py-4 font-bold text-white whitespace-nowrap">${escapeHtml(r.periodo)}</td>
            <td class="px-6 py-4 text-center text-slate-300">${r.pedidos}</td>
            <td class="px-6 py-4 text-center text-emerald-400 font-bold">${r.confirmadas}</td>
            <td class="px-6 py-4 text-center text-amber-400 font-bold">${r.pendientes}</td>
            <td class="px-6 py-4 text-center text-rose-400 font-bold">${r.canceladas}</td>
            <td class="px-6 py-4 text-white font-extrabold">${m(r.ingresos)}</td>
            <td class="px-6 py-4 text-indigo-400 font-bold">${m(r.comisiones)}</td>
            <td class="px-6 py-4 text-emerald-400 font-extrabold">${m(r.ganancia)}</td>
        </tr>`).join('');

    // Fila de totales del listado mostrado
    const sum = k => rows.reduce((acc, r) => acc + Number(r[k] || 0), 0);
    tbody.innerHTML += `
        <tr class="bg-slate-950 font-black text-white">
            <td class="px-6 py-4">TOTAL</td>
            <td class="px-6 py-4 text-center">${sum('pedidos')}</td>
            <td class="px-6 py-4 text-center text-emerald-400">${sum('confirmadas')}</td>
            <td class="px-6 py-4 text-center text-amber-400">${sum('pendientes')}</td>
            <td class="px-6 py-4 text-center text-rose-400">${sum('canceladas')}</td>
            <td class="px-6 py-4">${m(sum('ingresos'))}</td>
            <td class="px-6 py-4 text-indigo-400">${m(sum('comisiones'))}</td>
            <td class="px-6 py-4 text-emerald-400">${m(sum('ganancia'))}</td>
        </tr>`;
}

async function adminRpcAndRefresh(fn, params, okMsg) {
    const { error } = await supabase.rpc(fn, params);
    if (error) { alert('No se pudo completar la acción: ' + error.message); return; }
    if (okMsg) showToast(okMsg);
    renderAdminDashboard();
}

window.adminSetSaleStatus = function (id, estado) {
    if (estado === 'cancelada' && !confirm('¿Cancelar esta venta? Dejará de contar para comisiones.')) return;
    adminRpcAndRefresh('admin_set_sale_status', { p_id: id, p_estado: estado }, `Venta #${id}: ${estado}`);
};
window.adminSetCommissionPaid = function (id, pagada) {
    adminRpcAndRefresh('admin_set_commission_paid', { p_id: id, p_pagada: pagada }, pagada ? 'Comisión marcada como pagada' : 'Pago deshecho');
};
window.adminPayAffiliate = async function (codigo, moneda) {
    // Solo las comisiones de ESA moneda: pagar pesos no debe marcar como pagados los dólares.
    const pending = salesHistory.filter(s => s.codigo === codigo && estadoDe(s) === 'confirmada'
        && !s.comision_pagada && saleCurrency(s) === moneda);
    if (pending.length === 0) return;
    const total = pending.reduce((acc, s) => acc + Number(s.comision_ganada || 0), 0);
    if (!confirm(`¿Marcar como pagadas ${pending.length} comisión(es) de ${codigo} por ${fmtMoney(total, moneda)}?`)) return;
    const results = await Promise.all(pending.map(s => supabase.rpc('admin_set_commission_paid', { p_id: s.id, p_pagada: true })));
    const failed = results.find(r => r.error);
    if (failed) alert('No se pudieron marcar todas: ' + failed.error.message);
    else showToast('Comisiones marcadas como pagadas');
    renderAdminDashboard();
};

// --- 2. GESTIÓN DE PRODUCTOS (CRUD) ---

// Trae el proveedor real de cada producto. Esta tabla NO tiene política
// pública en Supabase: si quien llama no es un admin autenticado, Supabase
// simplemente devuelve 0 filas (no un error), así que esta función es segura
// de llamar siempre, pero solo se usa aquí, dentro del panel admin.
async function loadProductSuppliers() {
    const { data, error } = await supabase.from('product_suppliers').select('product_id, nombre, telefono, costo, comision');
    if (error) {
        console.error('Error cargando proveedores:', error.message);
        productSuppliers = {};
        return;
    }
    productSuppliers = {};
    (data || []).forEach(row => {
        productSuppliers[row.product_id] = { nombre: row.nombre || '', telefono: row.telefono || '', costo: row.costo, comision: Number(row.comision || 0) };
    });
}

function stockCell(p) {
    if (p.stock === null || p.stock === undefined) return `<span class="text-slate-500 text-xs italic">Sin límite</span>`;
    if (p.stock <= 0) return `<span class="bg-rose-500/10 text-rose-400 font-bold px-2.5 py-1 rounded-lg text-xs">Agotado</span>`;
    const low = p.stock <= LOW_STOCK_THRESHOLD;
    return `<span class="${low ? 'bg-amber-500/10 text-amber-400' : 'bg-emerald-500/10 text-emerald-400'} font-bold px-2.5 py-1 rounded-lg text-xs">${p.stock} uds</span>`;
}

// Reabastecer: suma unidades al stock actual (si estaba sin control, arranca desde 0).
async function restockProduct(id) {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const current = (p.stock === null || p.stock === undefined) ? 0 : p.stock;
    const input = prompt(`¿Cuántas unidades ingresaron de "${p.name}"?\nStock actual: ${current}`, '10');
    if (input === null) return;
    const qty = parseInt(input, 10);
    if (isNaN(qty) || qty <= 0) { alert('Escribe un número mayor que 0.'); return; }
    const { error } = await supabase.from('products').update({ stock: current + qty }).eq('id', id);
    if (error) {
        alert('No se pudo actualizar el stock: ' + error.message + '\n\n¿Corriste la migración MIGRACION_v4_stock.sql en Supabase?');
        return;
    }
    await loadCatalog();
    renderAdminProducts();
    showToast(`Stock de ${p.name}: ${current + qty} unidades`);
}
window.restockProduct = restockProduct;

async function renderAdminProducts() {
    await loadProductSuppliers();

    const tbody = document.getElementById('admin-products-table');
    if (products.length === 0) {
        tbody.innerHTML = `<tr><td colspan="8" class="px-6 py-10 text-center text-slate-500">No hay productos registrados.</td></tr>`;
        return;
    }

    tbody.innerHTML = products.map(p => {
        const supplier = productSuppliers[p.id] || { nombre: '', telefono: '' };
        const supplierCell = supplier.nombre || supplier.telefono
            ? `<div class="text-xs">
                   <p class="font-semibold text-white">${escapeHtml(supplier.nombre || '(sin nombre)')}</p>
                   ${supplier.telefono ? `<a href="https://wa.me/${escapeHtml(supplier.telefono.replace(/\D/g, ''))}" target="_blank" rel="noopener" class="text-emerald-400 hover:text-emerald-300 font-medium">${escapeHtml(supplier.telefono)}</a>` : ''}
               </div>`
            : `<span class="text-slate-600 text-xs italic">Sin asignar</span>`;

        // Ganancia limpia por unidad (precio - costo)
        let profitCell = '<span class="text-amber-400 text-xs italic">Falta costo</span>';
        if (supplier.costo !== null && supplier.costo !== undefined) {
            const base = p.price - Number(supplier.costo);
            profitCell = `<div class="text-xs"><p class="font-bold ${base > 0 ? 'text-emerald-400' : 'text-rose-400'}">${fmtMoney(base, p.currency)}</p></div>`;
        }

        return `
        <tr class="hover:bg-slate-800/50 transition-colors">
            <td class="px-6 py-4">
                ${(() => {
                    const adminImgAttrs = getResponsiveImageAttrs(p.image, 96);
                    return `<img src="${adminImgAttrs.src}" ${adminImgAttrs.srcset ? `srcset="${adminImgAttrs.srcset}" sizes="${adminImgAttrs.sizes}"` : ''} alt="${escapeHtml(p.name)}" width="48" height="48" loading="lazy" decoding="async" class="w-12 h-12 object-cover rounded-xl bg-slate-950 border border-slate-800" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">`;
                })()}
            </td>
            <td class="px-6 py-4 font-bold text-white">${escapeHtml(p.name)}</td>
            <td class="px-6 py-4"><span class="bg-indigo-500/10 text-indigo-400 font-semibold px-2.5 py-1 rounded-lg text-xs capitalize">${escapeHtml(p.category)}</span>${p.subcategory ? `<span class="block text-[11px] text-slate-500 mt-1 capitalize">${escapeHtml(p.subcategory)}</span>` : ''}</td>
            <td class="px-6 py-4 font-extrabold text-white">${priceHtml(p.price, p.currency)}</td>
            <td class="px-6 py-4">${profitCell}</td>
            <td class="px-6 py-4">${stockCell(p)}</td>
            <td class="px-6 py-4">${supplierCell}</td>
            <td class="px-6 py-4 text-right space-x-2">
                <button onclick="restockProduct(${p.id})" class="text-emerald-400 hover:text-emerald-300 font-semibold text-xs bg-emerald-500/10 hover:bg-emerald-500/20 px-3 py-1.5 rounded-lg transition-colors">+ Stock</button>
                <button onclick="openProductModal(${p.id})" class="text-indigo-400 hover:text-indigo-300 font-semibold text-xs bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors">Editar</button>
                <button onclick="deleteProduct(${p.id})" class="text-rose-400 hover:text-rose-300 font-semibold text-xs bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-colors">Eliminar</button>
            </td>
        </tr>
    `;
    }).join('');
}


function openProductModal(id = null) {
    if (id instanceof Event || (id && typeof id === 'object' && id.target)) {
        id = null;
    }
    editingProductId = id;
    const modal = document.getElementById('product-modal');
    const title = document.getElementById('product-modal-title');
    const catSelect = document.getElementById('prod-category');

    catSelect.innerHTML = categories.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c.toUpperCase())}</option>`).join('');

    if (id !== null && id !== undefined) {
        title.textContent = "Editar Producto";
        const p = products.find(x => x.id === id);
        if (p) {
            document.getElementById('prod-name').value = p.name;
            document.getElementById('prod-category').value = p.category;
            document.getElementById('prod-price').value = p.price;
            const curEl = document.getElementById('prod-currency');
            if (curEl) curEl.value = currencyOf(p);
            document.getElementById('prod-original-price').value = p.originalPrice || '';
            document.getElementById('prod-badge').value = p.badge || '';
            document.getElementById('prod-image').value = p.image;
            setProductImagePreview(p.image);
            document.getElementById('prod-desc').value = p.description;
        }
        const supplier = productSuppliers[id] || { nombre: '', telefono: '' };
        document.getElementById('prod-supplier-name').value = supplier.nombre;
        document.getElementById('prod-supplier-phone').value = supplier.telefono;
        document.getElementById('prod-cost').value = (supplier.costo !== null && supplier.costo !== undefined) ? supplier.costo : '';
        document.getElementById('prod-discount').value = (p && p.affiliateDiscount) ? p.affiliateDiscount : 0;
        document.getElementById('prod-commission').value = supplier.comision || 0;
        const stockEl = document.getElementById('prod-stock');
        if (stockEl) stockEl.value = (p && p.stock !== null && p.stock !== undefined) ? p.stock : '';
    } else {
        title.textContent = "Nuevo Producto";
        const form = document.getElementById('product-form');
        if (form) form.reset();
        setProductImagePreview('');
        document.getElementById('prod-image-status').textContent = '';
        document.getElementById('prod-discount').value = 0;
        document.getElementById('prod-commission').value = 0;
    }
    const editingProduct = products.find(x => x.id === editingProductId);
    refreshProductSubcategoryOptions(editingProduct ? editingProduct.subcategory : '');
    updateMarginPreview();

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

// Llena el selector de subcategoría con las de la categoría elegida en el formulario.
function refreshProductSubcategoryOptions(selected) {
    const sel = document.getElementById('prod-subcategory');
    if (!sel) return;
    const cat = document.getElementById('prod-category').value;
    const subs = subcategories.filter(s => s.category === cat);
    sel.innerHTML = '<option value="">Sin subcategoría</option>' +
        subs.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.name.toUpperCase())}</option>`).join('');
    sel.value = subs.some(s => s.name === selected) ? selected : '';
}

function closeProductModal() {
    document.getElementById('product-modal').classList.add('hidden');
    document.getElementById('product-modal').classList.remove('flex');
}

function currencyFromForm() {
    const el = document.getElementById('prod-currency');
    return el && el.value === 'USD' ? 'USD' : 'CUP';
}

// Vista previa en vivo de tu ganancia mientras llenas el formulario
function updateMarginPreview() {
    const el = document.getElementById('prod-margin-preview');
    if (!el) return;
    const price = parseFloat(document.getElementById('prod-price').value);
    const cost = parseFloat(document.getElementById('prod-cost').value);
    if (isNaN(price) || isNaN(cost)) { el.innerHTML = ''; return; }
    const base = price - cost;
    const cls = base < 0 ? 'text-rose-400' : (base === 0 ? 'text-amber-400' : 'text-emerald-400');
    el.innerHTML = `Ganancia por unidad: <span class="${cls}">${fmtMoney(base, currencyFromForm())}</span> <span class="text-slate-500">(el descuento y la comisión ahora se definen en cada afiliado)</span>`;
}

function setProductImagePreview(url) {
    const img = document.getElementById('prod-image-preview');
    if (!img) return;
    if (url) {
        img.src = url;
        img.classList.remove('hidden');
    } else {
        img.src = '';
        img.classList.add('hidden');
    }
}

// Sube la imagen elegida al bucket "products" de Supabase Storage y pone
// la URL pública resultante en el campo de texto (que sigue existiendo
// por si el admin prefiere pegar una URL externa en vez de subir un archivo).
async function handleProductImageUpload(e) {
    const file = e.target.files && e.target.files[0];
    const status = document.getElementById('prod-image-status');
    if (!file) return;

    const maxBytes = 5 * 1024 * 1024;
    const allowed = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
    if (!allowed.includes(file.type)) {
        status.textContent = 'Formato no permitido. Usa PNG, JPG, WEBP o GIF.';
        status.className = 'text-xs text-rose-400 mt-1.5';
        e.target.value = '';
        return;
    }
    if (file.size > maxBytes) {
        status.textContent = 'La imagen pesa más de 5MB. Comprímela e inténtalo de nuevo.';
        status.className = 'text-xs text-rose-400 mt-1.5';
        e.target.value = '';
        return;
    }

    status.textContent = 'Subiendo imagen...';
    status.className = 'text-xs text-slate-400 mt-1.5';
    e.target.disabled = true;

    const ext = file.name.split('.').pop().toLowerCase();
    const path = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const { error } = await supabase.storage.from('products').upload(path, file, {
        cacheControl: '3600',
        upsert: false
    });

    e.target.disabled = false;

    if (error) {
        status.textContent = 'No se pudo subir la imagen: ' + error.message;
        status.className = 'text-xs text-rose-400 mt-1.5';
        e.target.value = '';
        return;
    }

    const { data } = supabase.storage.from('products').getPublicUrl(path);
    document.getElementById('prod-image').value = data.publicUrl;
    setProductImagePreview(data.publicUrl);
    status.textContent = 'Imagen subida ✅';
    status.className = 'text-xs text-emerald-400 mt-1.5';
}

async function handleSaveProduct(e) {
    e.preventDefault();
    const name = document.getElementById('prod-name').value.trim();
    const category = document.getElementById('prod-category').value;
    const price = parseFloat(document.getElementById('prod-price').value);
    const originalPrice = parseFloat(document.getElementById('prod-original-price').value) || null;
    const badge = document.getElementById('prod-badge').value.trim() || null;
    const image = document.getElementById('prod-image').value.trim();
    const description = document.getElementById('prod-desc').value.trim();
    const supplierName = document.getElementById('prod-supplier-name').value.trim() || null;
    const supplierPhone = document.getElementById('prod-supplier-phone').value.trim() || null;
    const costo = parseFloat(document.getElementById('prod-cost').value);
    const descuento = parseFloat(document.getElementById('prod-discount').value) || 0;
    const comision = parseFloat(document.getElementById('prod-commission').value) || 0;
    const subcategory = (document.getElementById('prod-subcategory') || {}).value || '';
    const stockEl = document.getElementById('prod-stock');
    const stockRaw = stockEl ? stockEl.value.trim() : '';
    const stockParsed = parseInt(stockRaw, 10);
    const stock = (stockRaw === '' || isNaN(stockParsed)) ? null : Math.max(0, stockParsed);

    // Todo se guarda en una sola llamada al servidor, que además valida el
    // candado anti-pérdida: (precio - descuento - comisión) no puede quedar por debajo del costo.
    const { data: savedId, error } = await supabase.rpc('admin_save_product', {
        p_id: editingProductId,
        p_name: name, p_category: category, p_price: price, p_original_price: originalPrice,
        p_image: image, p_description: description, p_badge: badge,
        p_descuento: descuento, p_costo: costo, p_comision: comision,
        p_prov_nombre: supplierName, p_prov_telefono: supplierPhone
    });

    if (error) {
        alert('No se pudo guardar el producto: ' + error.message);
        return;
    }

    // El stock se guarda aparte (columna products.stock; la función del servidor no cambia).
    if (stockEl && savedId) {
        const { error: stockErr } = await supabase.from('products').update({ stock }).eq('id', savedId);
        if (stockErr) alert('El producto se guardó, pero no se pudo guardar el stock: ' + stockErr.message + '\n\n¿Corriste la migración MIGRACION_v4_stock.sql en Supabase?');
    }

    // La moneda se guarda aparte (columna products.moneda; la función del servidor no cambia).
    const currencyEl = document.getElementById('prod-currency');
    if (currencyEl && savedId) {
        const { error: curErr } = await supabase.from('products').update({ moneda: currencyEl.value === 'USD' ? 'USD' : 'CUP' }).eq('id', savedId);
        if (curErr) alert('El producto se guardó, pero no se pudo guardar la moneda: ' + curErr.message + '\n\n¿Ejecutaste migracion-moneda.sql en Supabase?');
    }

    await applyProductSubcategory(name, category, subcategory);

    await loadCatalog();
    closeProductModal();
    renderAdminProducts();
    showToast("Producto guardado exitosamente");
}

// La subcategoría se asigna con su propia función del servidor (no toca el guardado de costos/márgenes).
async function applyProductSubcategory(name, category, subcategory) {
    if (!document.getElementById('prod-subcategory')) return; // HTML sin actualizar
    const previous = products.find(x => x.id === editingProductId);
    // Solo se llama si hay algo que asignar o algo que quitar; así todo sigue funcionando
    // igual aunque la migración de subcategorías aún no se haya corrido.
    if (!subcategory && !(previous && previous.subcategory)) return;

    let productId = editingProductId;
    if (!productId) {
        // Producto nuevo: el más reciente con ese nombre y categoría es el que se acaba de crear.
        const { data } = await supabase.from('products').select('id').eq('name', name).eq('category', category).order('id', { ascending: false }).limit(1);
        productId = data && data[0] ? data[0].id : null;
    }
    if (!productId) return;

    const { error } = await supabase.rpc('admin_set_product_subcategory', { p_product_id: productId, p_subcategory: subcategory || null });
    if (error) alert('El producto se guardó, pero no se pudo asignar la subcategoría: ' + error.message);
}

async function deleteProduct(id) {
    if (!confirm("¿Estás seguro de eliminar este producto?")) return;
    const { error } = await supabase.from('products').delete().eq('id', id);
    if (error) {
        alert('No se pudo eliminar: ' + error.message);
        return;
    }
    await loadCatalog();
    renderAdminProducts();
    showToast("Producto eliminado");
}

// --- 3. GESTIÓN DE CATEGORÍAS ---
function renderAdminCategories() {
    const list = document.getElementById('admin-categories-list');
    list.innerHTML = categories.map(cat => {
        const subs = subcategories.filter(s => s.category === cat);
        const chips = subs.length ? `
            <div class="flex flex-wrap gap-2 mt-3">
                ${subs.map(s => `
                    <span class="inline-flex items-center gap-1 bg-indigo-500/10 text-indigo-300 text-xs font-semibold pl-3 pr-1 py-1 rounded-full capitalize">
                        ${escapeHtml(s.name)}
                        <button data-sub-id="${Number(s.id)}" data-sub-name="${escapeHtml(s.name)}" class="delete-subcategory-btn w-5 h-5 rounded-full text-indigo-300 hover:bg-rose-500/20 hover:text-rose-300 leading-none" aria-label="Eliminar subcategoría ${escapeHtml(s.name)}">&times;</button>
                    </span>`).join('')}
            </div>` : '';
        return `
        <div class="bg-slate-950 p-4 rounded-2xl border border-slate-800">
            <div class="flex items-center justify-between gap-3">
                <span class="font-bold text-white capitalize">${escapeHtml(cat)}</span>
                <div class="flex items-center gap-2">
                    <button data-category="${escapeHtml(cat)}" class="add-subcategory-btn text-indigo-300 hover:text-indigo-200 text-xs font-bold bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors">+ Subcategoría</button>
                    <button data-category="${escapeHtml(cat)}" class="delete-category-btn text-rose-400 hover:text-rose-300 text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-colors">Eliminar</button>
                </div>
            </div>
            ${chips}
        </div>`;
    }).join('');
    list.querySelectorAll('.delete-category-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteCategory(btn.dataset.category));
    });
    list.querySelectorAll('.add-subcategory-btn').forEach(btn => {
        btn.addEventListener('click', () => openSubcategoryModal(btn.dataset.category));
    });
    list.querySelectorAll('.delete-subcategory-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteSubcategory(Number(btn.dataset.subId), btn.dataset.subName));
    });
}

// --- SUBCATEGORÍAS (CRUD) ---
let pendingSubcategoryParent = null;

function isMissingSubcategoriesTable(error) {
    return error && (error.code === '42P01' || error.code === 'PGRST205' || /subcategories/i.test(error.message || ''));
}

function openSubcategoryModal(parentCategory) {
    const modal = document.getElementById('subcat-modal');
    if (!modal) {
        alert('Falta actualizar el HTML de esta página para poder crear subcategorías (sube la versión nueva de los archivos .html).');
        return;
    }
    pendingSubcategoryParent = parentCategory;
    document.getElementById('subcat-parent-label').textContent = parentCategory;
    document.getElementById('subcategory-form').reset();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeSubcategoryModal() {
    const modal = document.getElementById('subcat-modal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function handleSaveSubcategory(e) {
    e.preventDefault();
    const name = document.getElementById('subcat-name').value.toLowerCase().trim();
    if (!name || !pendingSubcategoryParent) {
        alert('El nombre no puede estar vacío.');
        return;
    }

    const { error } = await supabase.from('subcategories').insert({ category: pendingSubcategoryParent, name });
    if (error) {
        if (error.code === '23505') alert('Esa subcategoría ya existe dentro de esta categoría.');
        else if (isMissingSubcategoriesTable(error)) alert('Falta correr la migración de subcategorías en Supabase (MIGRACION_v3_subcategorias.sql).');
        else alert('No se pudo guardar: ' + error.message);
        return;
    }

    await loadCatalog();
    closeSubcategoryModal();
    renderAdminCategories();
    showToast('Subcategoría añadida');
}

async function deleteSubcategory(id, name) {
    if (!confirm(`¿Eliminar la subcategoría "${name}"?`)) return;
    const { error } = await supabase.from('subcategories').delete().eq('id', id);
    if (error) {
        alert(error.code === '23503'
            ? 'No se puede eliminar: todavía hay productos en esta subcategoría. Muévelos o quítales la subcategoría primero.'
            : 'No se pudo eliminar: ' + error.message);
        return;
    }
    await loadCatalog();
    renderAdminCategories();
    showToast('Subcategoría eliminada');
}

function openCategoryModal() {
    document.getElementById('cat-modal').classList.remove('hidden');
    document.getElementById('cat-modal').classList.add('flex');
    document.getElementById('category-form').reset();
}

function closeCategoryModal() {
    document.getElementById('cat-modal').classList.add('hidden');
    document.getElementById('cat-modal').classList.remove('flex');
}

async function handleSaveCategory(e) {
    e.preventDefault();
    const catName = document.getElementById('cat-name').value.toLowerCase().trim();
    if (!catName) {
        alert("El nombre no puede estar vacío.");
        return;
    }

    const { error } = await supabase.from('categories').insert({ name: catName });
    if (error) {
        alert(error.code === '23505' ? 'Esa categoría ya existe.' : 'No se pudo guardar: ' + error.message);
        return;
    }

    await loadCatalog();
    closeCategoryModal();
    renderAdminCategories();
    showToast("Categoría añadida");
}

async function deleteCategory(catName) {
    if (!confirm(`¿Eliminar categoría "${catName}"?`)) return;
    const { error } = await supabase.from('categories').delete().eq('name', catName);
    if (error) {
        alert(error.code === '23503'
            ? 'No se puede eliminar: todavía hay productos en esta categoría.'
            : 'No se pudo eliminar: ' + error.message);
        return;
    }
    await loadCatalog();
    renderAdminCategories();
    showToast("Categoría eliminada");
}

// --- 4. GESTIÓN DE AFILIADOS (CRUD) ---
async function renderAdminAffiliates() {
    const tbody = document.getElementById('admin-affiliates-table');
    const { data, error } = await supabase
        .from('affiliates')
        .select('id,codigo,nombre,descuento,comision')
        .order('codigo');

    if (error) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-rose-400">Error cargando afiliados: ${escapeHtml(error.message)}</td></tr>`;
        return;
    }

    lastAdminAffiliates = data || [];

    if (lastAdminAffiliates.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">No hay afiliados registrados.</td></tr>`;
        return;
    }

    tbody.innerHTML = lastAdminAffiliates.map(a => `
        <tr class="hover:bg-slate-800/50 transition-colors">
            <td class="px-6 py-4 font-mono font-extrabold text-white">${escapeHtml(a.codigo)}</td>
            <td class="px-6 py-4 font-semibold text-slate-200">${escapeHtml(a.nombre)}</td>
            <td class="px-6 py-4 font-bold text-emerald-400">${Number(a.descuento || 0)}%</td>
            <td class="px-6 py-4 font-bold text-indigo-400">${Number(a.comision || 0)}%</td>
            <td class="px-6 py-4 text-right space-x-2">
                <button onclick="openAffiliateModal(${a.id})" class="text-indigo-400 hover:text-indigo-300 font-semibold text-xs bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors">Editar</button>
                <button onclick="deleteAffiliate(${a.id})" class="text-rose-400 hover:text-rose-300 font-semibold text-xs bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-colors">Eliminar</button>
            </td>
        </tr>
    `).join('');
}

function openAffiliateModal(id = null) {
    if (id instanceof Event || (id && typeof id === 'object' && id.target)) {
        id = null;
    }
    editingAffiliateId = id;
    const modal = document.getElementById('affiliate-modal');
    const title = document.getElementById('affiliate-modal-title');
    const pinInput = document.getElementById('aff-pin');

    // Si index.html quedó desactualizado (sin los campos de descuento/comisión)
    // se avisa en vez de fallar en silencio con el modal sin abrir.
    if (!document.getElementById('aff-discount') || !document.getElementById('aff-commission')) {
        alert('El formulario de afiliados está desactualizado: sube también el index.html nuevo y recarga con Ctrl+Shift+R.');
        return;
    }

    if (id !== null && id !== undefined) {
        title.textContent = "Editar Afiliado";
        const a = lastAdminAffiliates.find(x => x.id === id);
        if (a) {
            document.getElementById('aff-code').value = a.codigo;
            document.getElementById('aff-name').value = a.nombre;
            document.getElementById('aff-discount').value = Number(a.descuento || 0);
            document.getElementById('aff-commission').value = Number(a.comision || 0);
        }
        pinInput.value = '';
        pinInput.required = false;
        pinInput.placeholder = 'Dejar en blanco para no cambiarlo';
    } else {
        title.textContent = "Nuevo Afiliado";
        const form = document.getElementById('affiliate-form');
        if (form) form.reset();
        pinInput.required = true;
        pinInput.placeholder = 'Ej. 1234';
    }

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }

    const discInput = document.getElementById('aff-discount');
    discInput.oninput = updateAffiliateWarning;
    updateAffiliateWarning();
}

// Aviso en vivo: el descuento (%) se aplica sobre el precio, así que si supera el
// margen de algún producto se vendería por debajo del costo. La comisión no puede
// causar pérdida porque se calcula sobre tu ganancia.
async function updateAffiliateWarning() {
    const el = document.getElementById('aff-warning');
    if (!el) return;
    if (Object.keys(productSuppliers).length === 0) await loadProductSuppliers();

    const d = parseFloat(document.getElementById('aff-discount').value) || 0;
    let maxSafe = 100, tightest = null;
    const risky = [];
    products.forEach(p => {
        const sup = productSuppliers[p.id];
        if (!sup || sup.costo === null || sup.costo === undefined || !(p.price > 0)) return;
        const margenPct = (p.price - Number(sup.costo)) / p.price * 100;
        if (margenPct < maxSafe) { maxSafe = margenPct; tightest = p.name; }
        if (d > margenPct) risky.push(p.name);
    });

    if (!tightest) { el.innerHTML = ''; return; }
    const safeTxt = `Descuento máximo sin perder dinero en todo el catálogo: <strong>${Math.max(0, maxSafe).toFixed(1)}%</strong> (menor margen: ${escapeHtml(tightest)}).`;
    if (risky.length > 0) {
        const list = risky.slice(0, 3).map(escapeHtml).join(', ') + (risky.length > 3 ? ` y ${risky.length - 3} más` : '');
        el.innerHTML = `<span class="text-rose-400">⚠ Con ${d}% perderías dinero en: ${list}.</span><br>${safeTxt}`;
    } else {
        el.innerHTML = safeTxt;
    }
}

function closeAffiliateModal() {
    document.getElementById('affiliate-modal').classList.add('hidden');
    document.getElementById('affiliate-modal').classList.remove('flex');
}

async function handleSaveAffiliate(e) {
    e.preventDefault();
    const codigo = document.getElementById('aff-code').value.toUpperCase().trim();
    const nombre = document.getElementById('aff-name').value.trim();
    const pin = document.getElementById('aff-pin').value.trim();
    const descuento = parseFloat(document.getElementById('aff-discount').value) || 0;
    const comision = parseFloat(document.getElementById('aff-commission').value) || 0;

    if (descuento < 0 || descuento > 100 || comision < 0 || comision > 100) {
        alert('El descuento y la comisión deben ser porcentajes entre 0 y 100.');
        return;
    }

    // El hash del PIN se genera DENTRO de la base de datos (admin_upsert_affiliate),
    // nunca en el navegador: así el PIN en texto plano jamás queda guardado en ningún lado.
    const { error } = await supabase.rpc('admin_upsert_affiliate', {
        p_id: editingAffiliateId,
        p_codigo: codigo,
        p_nombre: nombre,
        p_descuento: descuento,
        p_comision: comision,
        p_pin: pin || null
    });

    if (error) {
        alert('No se pudo guardar: ' + error.message);
        return;
    }

    closeAffiliateModal();
    await renderAdminAffiliates();
    showToast("Afiliado guardado con éxito");
}

async function deleteAffiliate(id) {
    if (!confirm("¿Estás seguro de eliminar este afiliado?")) return;
    const { error } = await supabase.from('affiliates').delete().eq('id', id);
    if (error) {
        alert('No se pudo eliminar: ' + error.message);
        return;
    }
    await renderAdminAffiliates();
    showToast("Afiliado eliminado");
}

