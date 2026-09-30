/* TinajitoStore — PORTAL DE EMBAJADORES (requiere app.js cargado antes) */
// --- PORTAL DE EMBAJADORES ---
function initPortalView() {
    const loginSection = document.getElementById('portal-login-section');
    const dashboardSection = document.getElementById('portal-dashboard-section');
    const errorDiv = document.getElementById('portal-login-error');
    if (errorDiv) errorDiv.classList.add('hidden');

    // Ya no se recuerda una sesión de afiliado entre visitas: como el PIN
    // nunca se guarda en el navegador, hay que volver a escribirlo cada vez
    // que se entra al portal. Es una pequeña molestia a cambio de que el
    // PIN jamás quede accesible en este dispositivo.
    currentAmbassador = null;
    salesHistory = [];

    loginSection.classList.remove('hidden');
    dashboardSection.classList.add('hidden');
    const codeInput = document.getElementById('codigoAfiliado');
    const pinInput = document.getElementById('pinAfiliado');
    if (codeInput) codeInput.value = '';
    if (pinInput) pinInput.value = '';
}

function portalSaleCurrency(s) { return (s.moneda === 'USD' || s._moneda === 'USD') ? 'USD' : saleCurrency(s); }

function renderPortalDashboard(aff) {
    const initials = aff.nombre.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('portal-avatar-initials').textContent = initials;
    document.getElementById('portal-affiliate-name').textContent = aff.nombre;
    document.getElementById('portal-affiliate-code').textContent = aff.codigo;

    // salesHistory ya viene filtrado por el servidor para este afiliado
    // (get_affiliate_sales solo devuelve filas que coinciden con su código
    // Y su PIN correcto).
    const ambassadorSales = salesHistory;
    // Solo las ventas confirmadas suman a sus totales.
    const confirmedSales = ambassadorSales.filter(s => (s.estado || 'confirmada') === 'confirmada');
    const totalSales = confirmedSales.length;
    // Totales por moneda (pesos y dólares nunca se suman).
    const sumByCur = key => {
        const o = {};
        confirmedSales.forEach(s => { const c = portalSaleCurrency(s); o[c] = (o[c] || 0) + Number(s[key] || 0); });
        return o;
    };
    const setMoneyLines = (id, byCur) => {
        const el = document.getElementById(id);
        // Siempre se muestran ambas monedas (USD primero), aunque una esté en 0.
        el.innerHTML = CURRENCY_ORDER.map(c => `<span class="block">${escapeHtml(fmtMoney(byCur[c] || 0, c))}</span>`).join('');
    };

    document.getElementById('portal-stat-sales').textContent = totalSales;
    setMoneyLines('portal-stat-revenue', sumByCur('monto_venta'));
    setMoneyLines('portal-stat-commission', sumByCur('comision_ganada'));

    const referralUrl = `${window.location.origin}${window.location.pathname}?ref=${aff.codigo}`;
    document.getElementById('portal-referral-link').value = referralUrl;

    const tbody = document.getElementById('portal-sales-table');
    if (ambassadorSales.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">Aún no tienes ventas registradas con tu código. ¡Comparte tu enlace!</td></tr>`;
        return;
    }

    tbody.innerHTML = ambassadorSales.map(s => {
        const dateStr = s.fecha ? new Date(s.fecha).toLocaleDateString() : 'Reciente';
        const cur = portalSaleCurrency(s);
        const st = s.estado || 'confirmada';
        const badge = st === 'pendiente' ? ['En revisión', 'bg-amber-500/10 text-amber-400']
            : st === 'cancelada' ? ['Cancelada', 'bg-rose-500/10 text-rose-400']
            : s.comision_pagada ? ['Pagada', 'bg-indigo-500/10 text-indigo-400']
            : ['Confirmada', 'bg-emerald-500/10 text-emerald-400'];
        return `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="px-6 py-4">
                    <span class="block font-bold text-white">#${s.id}</span>
                    <span class="block text-[11px] text-slate-400">${dateStr}</span>
                </td>
                <td class="px-6 py-4 text-slate-300 font-medium">${escapeHtml(s.cliente || 'Cliente General')}</td>
                <td class="px-6 py-4 text-white font-bold">${fmtMoney(s.monto_venta, cur)}</td>
                <td class="px-6 py-4 font-extrabold ${st === 'cancelada' ? 'text-slate-500 line-through' : st === 'pendiente' ? 'text-amber-400' : 'text-emerald-400'}">+${fmtMoney(s.comision_ganada, cur)}</td>
                <td class="px-6 py-4 text-center">
                    <span class="${badge[1]} font-bold px-3 py-1 rounded-full text-xs">${badge[0]}</span>
                </td>
            </tr>
        `;
    }).join('');
}

window.consultarEstadisticasAfiliado = async function () {
    const codigoEl = document.getElementById('codigoAfiliado');
    const pinEl = document.getElementById('pinAfiliado');

    const codigoInput = codigoEl ? codigoEl.value.toUpperCase().trim() : '';
    const pinInput = pinEl ? pinEl.value.trim() : '';
    const errorDiv = document.getElementById('portal-login-error');

    const { data, error } = await supabase.rpc('verify_affiliate_login', { p_codigo: codigoInput, p_pin: pinInput });

    if (error || !data || data.length === 0) {
        if (errorDiv) {
            errorDiv.textContent = 'Código o PIN incorrectos';
            errorDiv.classList.remove('hidden');
        } else {
            alert('Código o PIN incorrectos');
        }
        return false;
    }

    const socio = data[0];
    currentAmbassador = socio;

    const { data: sales, error: salesErr } = await supabase.rpc('get_affiliate_sales', { p_codigo: codigoInput, p_pin: pinInput });
    if (salesErr) console.warn('get_affiliate_sales falló:', salesErr.message);
    salesHistory = salesErr ? [] : (sales || []);
    // Moneda de cada venta (función opcional de migracion-moneda.sql). Si no existe, se deduce de order_ref o queda en CUP.
    try {
        const { data: curRows, error: curErr } = await supabase.rpc('get_affiliate_sales_currency', { p_codigo: codigoInput, p_pin: pinInput });
        if (curErr) console.warn('get_affiliate_sales_currency falló (las ventas en USD se verán como CUP):', curErr.message);
        if (!curErr && Array.isArray(curRows)) {
            const byId = new Map(curRows.map(r => [Number(r.id), r.moneda]));
            salesHistory.forEach(s => { if (byId.has(Number(s.id))) s._moneda = byId.get(Number(s.id)); });
        }
    } catch (e) { /* opcional */ }

    const loginSection = document.getElementById('portal-login-section');
    const dashboardSection = document.getElementById('portal-dashboard-section');
    if (loginSection) loginSection.classList.add('hidden');
    if (dashboardSection) dashboardSection.classList.remove('hidden');
    if (errorDiv) errorDiv.classList.add('hidden');

    renderPortalDashboard(socio);
    return false;
};

window.cerrarSesionEmbajador = function () {
    currentAmbassador = null;
    salesHistory = [];

    const loginSection = document.getElementById('portal-login-section');
    const dashboardSection = document.getElementById('portal-dashboard-section');
    const errorDiv = document.getElementById('portal-login-error');

    if (loginSection) loginSection.classList.remove('hidden');
    if (dashboardSection) dashboardSection.classList.add('hidden');
    if (errorDiv) errorDiv.classList.add('hidden');

    const codeInput = document.getElementById('codigoAfiliado');
    const pinInput = document.getElementById('pinAfiliado');
    if (codeInput) codeInput.value = '';
    if (pinInput) pinInput.value = '';

    if (typeof showToast === 'function') {
        showToast("Sesión cerrada correctamente");
    }
    return false;
};

