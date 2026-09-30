/* ==========================================
   TINAJITOSTORE - E-COMMERCE & ADMIN PANEL ENGINE
   Motor de datos: Supabase (Postgres + Auth + Row Level Security)
   ========================================== */

// --- CLIENTE SUPABASE ---
// Reutilizamos la variable global 'supabase' provista por el CDN sin declarar const ni let.
try {
    if (typeof supabase !== 'undefined' && typeof supabase.createClient === 'function' && typeof SUPABASE_URL !== 'undefined' && typeof SUPABASE_ANON_KEY !== 'undefined') {
        supabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    }
} catch (err) {
    console.error('Error al inicializar Supabase:', err);
}

// --- SEGURIDAD: ESCAPE DE HTML (anti-XSS) ---
// Cualquier dato que venga de un formulario (nombre de producto, categoría,
// afiliado, cliente, etc.) se trata como texto plano al insertarlo en el DOM.
function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[ch]));
}

// --- OPTIMIZACIÓN DE IMÁGENES (Responsive srcset, WebP auto y dimensiones) ---
function getResponsiveImageAttrs(imageUrl, widthPx = 600) {
    const esc = escapeHtml(imageUrl);
    if (imageUrl && imageUrl.includes('images.unsplash.com')) {
        const baseUrl = imageUrl.split('?')[0];
        return {
            src: `${baseUrl}?auto=format&fit=crop&w=${widthPx}&q=80`,
            srcset: `${baseUrl}?auto=format&fit=crop&w=480&q=80 480w, ${baseUrl}?auto=format&fit=crop&w=800&q=80 800w, ${baseUrl}?auto=format&fit=crop&w=1200&q=80 1200w`,
            sizes: '(max-width: 640px) 480px, (max-width: 1024px) 800px, 1200px'
        };
    }
    return {
        src: esc,
        srcset: '',
        sizes: ''
    };
}

// --- ESTADO LOCAL ---
// A partir de este rediseño, localStorage SOLO guarda cosas propias y no
// sensibles del visitante en su propio navegador (su carrito, el código de
// afiliado con el que está navegando). Todo lo demás -productos, categorías,
// afiliados, ventas, login- vive en Supabase y pasa por RLS.
function getStorage(key, fallback) {
    const data = localStorage.getItem('nexus_' + key);
    return data ? JSON.parse(data) : fallback;
}
function setStorage(key, value) {
    localStorage.setItem('nexus_' + key, JSON.stringify(value));
}

let products = [];
let categories = [];
let subcategories = []; // [{id, category, name}]
let cart = getStorage('cart', []);
let activeAffiliate = getStorage('active_affiliate', null); // {codigo, nombre, descuento}
let salesHistory = [];
let currentAmbassador = null; // nunca se persiste (ni él ni su PIN) en el navegador

const STORE_WHATSAPP_NUMBER = "5353554857";

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
    // 1. Inicializar la interfaz y los escuchadores de eventos ('click') de inmediato,
    // de forma independiente al estado de la red o Supabase.
    setupGlobalEvents();
    initStoreView();

    if (!supabase) {
        showConnectionError('Falta configurar la conexión a la base de datos en config.js');
        return;
    }

    // 2. Manejar las peticiones a Supabase de manera asíncrona sin bloquear la UI ni los eventos.
    initializeAppAsync();
    flushPendingSales();
});

function showConnectionError(message) {
    const grid = document.getElementById('products-grid');
    if (grid && products.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-16 bg-slate-900 rounded-3xl border border-slate-800 px-6">
                <svg class="w-12 h-12 mx-auto text-amber-500 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
                </svg>
                <h3 class="text-base font-semibold text-amber-400">Aviso de Conexión</h3>
                <p class="text-slate-400 text-sm mt-1">${escapeHtml(message)}</p>
            </div>`;
    }
}

async function initializeAppAsync() {
    try {
        await loadCatalog();
    } catch (err) {
        console.error('Error al cargar catálogo en segundo plano:', err);
    }

    try {
        const urlParams = new URLSearchParams(window.location.search);
        const refCode = urlParams.get('ref');
        // También se revalida el afiliado guardado en el navegador: así toma el
        // descuento vigente (o se descarta si el código ya no existe).
        const codeToCheck = refCode || (activeAffiliate && activeAffiliate.codigo);
        if (codeToCheck) {
            const found = await fetchPublicAffiliate(codeToCheck);
            if (found) {
                activeAffiliate = found;
                setStorage('active_affiliate', activeAffiliate);
                updateCartUI();
            } else if (!refCode) {
                activeAffiliate = null;
                setStorage('active_affiliate', null);
                updateCartUI();
            }
        }
    } catch (err) {
        console.error('Error al procesar enlace de referido:', err);
    }
}

// --- CACHÉ DEL CATÁLOGO (sessionStorage) ---
// Objetivo: al navegar entre index.html / audio.html / moda.html / etc. (páginas
// distintas, con recarga completa) no hacer esperar al visitante la misma
// consulta a Supabase una y otra vez. Vive solo en esta pestaña (sessionStorage)
// y se refresca solo, así que nunca queda "pegada" para siempre.
const CATALOG_CACHE_KEY = 'nexus_catalog_cache_v6'; // v6: subir el número al cambiar los campos del catálogo
const CATALOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutos

function readCatalogCache() {
    try {
        const raw = sessionStorage.getItem(CATALOG_CACHE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || !Array.isArray(parsed.products) || !Array.isArray(parsed.categories) || typeof parsed.ts !== 'number') {
            return null;
        }
        return parsed;
    } catch (err) {
        return null; // caché corrupta o sessionStorage no disponible (modo privado, etc.)
    }
}

function writeCatalogCache(cats, prods, subs) {
    try {
        sessionStorage.setItem(CATALOG_CACHE_KEY, JSON.stringify({ categories: cats, products: prods, subcategories: subs || [], ts: Date.now() }));
    } catch (err) {
        // No es crítico: si falla, simplemente no hay caché y se sigue pidiendo a Supabase.
    }
}

async function loadCatalog() {
    if (!supabase) {
        showConnectionError('Falta configurar la conexión a la base de datos en config.js');
        initStoreView();
        return;
    }

    // 1) Si hay una copia reciente en caché, pintamos con ella de inmediato
    //    (percepción de carga instantánea) mientras se confirma en segundo plano.
    let paintedFromCache = false;
    const cached = readCatalogCache();
    if (cached && (Date.now() - cached.ts) < CATALOG_CACHE_TTL_MS) {
        categories = cached.categories;
        products = cached.products;
        subcategories = Array.isArray(cached.subcategories) ? cached.subcategories : [];
        reconcileCartWithStock();
        initStoreView();
        paintedFromCache = true;
    }

    // 2) Siempre se confirma contra Supabase (esto es lo que deja el dato fresco
    //    y correcto, tanto en la primera carga como para refrescar la caché).
    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout al conectar con Supabase')), 8000)
        );

        const fetchPromise = Promise.all([
            supabase.from('categories').select('name').order('name'),
            supabase.from('products').select('*').order('id'),
            supabase.from('subcategories').select('id, category, name').order('name')
        ]);

        const [{ data: cats, error: catErr }, { data: prods, error: prodErr }, { data: subs, error: subErr }] = await Promise.race([
            fetchPromise,
            timeoutPromise
        ]);

        if (catErr) console.error('Error cargando categorías:', catErr.message);
        if (prodErr) console.error('Error cargando productos:', prodErr.message);
        // Si la tabla aún no existe (falta correr la migración v3) simplemente no hay subcategorías.
        if (subErr) console.warn('Subcategorías no disponibles (¿falta la migración v3?):', subErr.message);

        categories = (cats || []).map(c => c.name);
        products = (prods || []).map(p => ({
            id: p.id,
            name: p.name,
            category: p.category,
            price: Number(p.price),
            originalPrice: p.original_price !== null ? Number(p.original_price) : null,
            image: p.image,
            description: p.description,
            badge: p.badge,
            subcategory: p.subcategory || null,
            stock: (p.stock === null || p.stock === undefined) ? null : Number(p.stock), // null = sin control; 0 = agotado
            currency: p.moneda === 'USD' ? 'USD' : 'CUP', // moneda de venta del producto
            affiliateDiscount: Number(p.descuento_afiliado || 0) // pesos por unidad; es público (se ve como ahorro en el carrito)
        }));

        subcategories = subErr ? [] : (subs || []).map(s => ({ id: s.id, category: s.category, name: s.name }));

        writeCatalogCache(categories, products, subcategories);
        reconcileCartWithStock();
        initStoreView();
    } catch (err) {
        console.error('Error al cargar catálogo:', err);
        // Si ya habíamos pintado con la caché, la dejamos visible en vez de taparla
        // con un aviso de error: es mejor mostrar datos un poco viejos que nada.
        if (!paintedFromCache) {
            showConnectionError('No se pudo establecer conexión con Supabase. Puedes interactuar con la interfaz visual y el carrito localmente.');
            initStoreView();
        }
    }
}

// Datos públicos de un afiliado (código, nombre y descuento al cliente, para
// validar el código y mostrar el ahorro en el carrito). Nunca expone el PIN ni la comisión.
async function fetchPublicAffiliate(codigo) {
    if (!supabase) return null;
    try {
        const { data, error } = await supabase.rpc('get_public_affiliate', { p_codigo: codigo });
        if (error || !data || data.length === 0) return null;
        return data[0];
    } catch (err) {
        console.error('Error al obtener afiliado público:', err);
        return null;
    }
}

// --- MONEDAS ---
// Cada producto se vende en CUP (pesos) o USD (dólares). Las dos monedas NUNCA se suman entre sí:
// el carrito, los pedidos y los reportes las llevan por separado.
const CURRENCY_ORDER = ['USD', 'CUP'];
function currencyOf(x) { return x && x.currency === 'USD' ? 'USD' : 'CUP'; }
function fmtMoney(amount, currency) {
    return `$${Number(amount || 0).toFixed(2)} ${currency === 'USD' ? 'USD' : 'CUP'}`;
}
// Igual que fmtMoney pero con el código de moneda en pequeño (para tarjetas y tablas).
function priceHtml(amount, currency) {
    return `$${Number(amount || 0).toFixed(2)}<span class="ml-1 text-[10px] font-bold text-slate-400 tracking-wide">${currency === 'USD' ? 'USD' : 'CUP'}</span>`;
}
// La moneda vigente del producto manda sobre la copia guardada en el carrito.
function cartItemCurrency(item) {
    const live = products.find(p => p.id === item.id);
    return currencyOf(live || item);
}
// Descuento del afiliado: un PORCENTAJE del subtotal (0-100), aplicado por moneda.
// Solo es para mostrarlo; el servidor lo recalcula al registrar la venta.
function cartTotals() {
    const pct = activeAffiliate ? Math.min(100, Math.max(0, Number(activeAffiliate.descuento || 0))) : 0;
    const totals = {};
    cart.forEach(item => {
        const cur = cartItemCurrency(item);
        if (!totals[cur]) totals[cur] = { subtotal: 0, discount: 0, total: 0 };
        totals[cur].subtotal += item.price * item.quantity;
    });
    Object.values(totals).forEach(t => {
        t.discount = Math.round(t.subtotal * pct) / 100;
        t.total = Math.max(0, t.subtotal - t.discount);
    });
    return totals;
}
// "$10.00 USD + $500.00 CUP" (o solo una moneda si el carrito tiene una).
function joinCurrencyTotals(totals, key, prefix = '') {
    const parts = CURRENCY_ORDER.filter(c => totals[c]).map(c => prefix + fmtMoney(totals[c][key], c));
    return parts.length ? parts.join(' + ') : fmtMoney(0, 'CUP');
}

// --- CONFIGURACIÓN DE EVENTOS GLOBALES ---
function setupGlobalEvents() {
    ['prod-price', 'prod-cost', 'prod-discount', 'prod-commission', 'prod-currency'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.addEventListener('input', updateMarginPreview);
    });
    document.getElementById('nav-store-btn').addEventListener('click', () => switchView('store'));
    document.getElementById('back-to-store-btn').addEventListener('click', () => switchView('store'));

    const adminFooterLink = document.getElementById('admin-footer-link');
    if (adminFooterLink) {
        adminFooterLink.addEventListener('click', (e) => {
            e.preventDefault();
            openAdminLoginModal();
        });
    }

    const adminLoginForm = document.getElementById('admin-login-form');
    if (adminLoginForm) adminLoginForm.addEventListener('submit', handleAdminLogin);

    const closeAdminLoginBtn = document.getElementById('close-admin-login-btn');
    if (closeAdminLoginBtn) closeAdminLoginBtn.addEventListener('click', closeAdminLoginModal);

    const adminLogoutBtn = document.getElementById('admin-logout-btn');
    if (adminLogoutBtn) {
        adminLogoutBtn.addEventListener('click', async () => {
            await supabase.auth.signOut();
            switchView('store');
            showToast('Sesión de administrador cerrada');
        });
    }

    document.getElementById('cart-btn').addEventListener('click', toggleCart);
    document.getElementById('close-cart').addEventListener('click', toggleCart);
    document.getElementById('cart-overlay').addEventListener('click', toggleCart);

    document.getElementById('search-input').addEventListener('input', applySearchAndFilter);
    if (document.getElementById('search-input-mobile')) {
        document.getElementById('search-input-mobile').addEventListener('input', applySearchAndFilter);
    }

    document.getElementById('apply-affiliate-btn').addEventListener('click', applyAffiliateFromInput);

    document.getElementById('open-checkout-btn').addEventListener('click', () => {
        if (cart.length === 0) return;
        toggleCart();
        document.getElementById('checkout-modal').classList.remove('hidden');
        document.getElementById('checkout-modal').classList.add('flex');
    });

    document.getElementById('close-checkout-btn').addEventListener('click', () => {
        document.getElementById('checkout-modal').classList.add('hidden');
        document.getElementById('checkout-modal').classList.remove('flex');
        clearActiveAffiliate(); // se canceló la compra: no dejar el código aplicado
        updateCartUI();
    });

    document.getElementById('checkout-form').addEventListener('submit', sendWhatsAppOrder);

    document.querySelectorAll('.admin-tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const tabName = e.target.dataset.tab;
            switchAdminTab(tabName);
        });
    });

    document.getElementById('add-product-btn').addEventListener('click', () => openProductModal());
    document.getElementById('product-form').addEventListener('submit', handleSaveProduct);
    document.getElementById('prod-image-file').addEventListener('change', handleProductImageUpload);

    const prodCatSelect = document.getElementById('prod-category');
    if (prodCatSelect) prodCatSelect.addEventListener('change', () => refreshProductSubcategoryOptions(''));
    const subcatForm = document.getElementById('subcategory-form');
    if (subcatForm) subcatForm.addEventListener('submit', handleSaveSubcategory);

    document.getElementById('add-category-btn').addEventListener('click', openCategoryModal);
    document.getElementById('category-form').addEventListener('submit', handleSaveCategory);

    document.getElementById('add-affiliate-btn').addEventListener('click', () => openAffiliateModal());

    // Detalle de pedido + exportación CSV (panel admin)
    const exportCsvBtn = document.getElementById('export-sales-csv-btn');
    if (exportCsvBtn) exportCsvBtn.addEventListener('click', () => exportSalesCSV());
    const orderDetailModal = document.getElementById('order-detail-modal');
    if (orderDetailModal) {
        orderDetailModal.addEventListener('click', (e) => { if (e.target === orderDetailModal) closeOrderDetail(); });
        const closeDetailBtn = document.getElementById('close-order-detail-btn');
        if (closeDetailBtn) closeDetailBtn.addEventListener('click', closeOrderDetail);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeOrderDetail(); });
    }
    document.getElementById('affiliate-form').addEventListener('submit', handleSaveAffiliate);

    const portalBtn = document.getElementById('btnEmbajadores');
    if (portalBtn) {
        portalBtn.addEventListener('click', (e) => {
            e.preventDefault();
            switchView('portal');
        });
    }

    const portalBackBtn = document.getElementById('cerrarModalEmbajadores');
    if (portalBackBtn) {
        portalBackBtn.addEventListener('click', (e) => {
            e.preventDefault();
            switchView('store');
        });
    }

    const portalLoginForm = document.getElementById('portal-login-form');
    if (portalLoginForm) {
        portalLoginForm.addEventListener('submit', (e) => {
            e.preventDefault();
            consultarEstadisticasAfiliado();
        });
    }

    const portalLogoutBtn = document.getElementById('portal-logout-btn');
    if (portalLogoutBtn) {
        portalLogoutBtn.addEventListener('click', () => cerrarSesionEmbajador());
    }

    const portalCopyBtn = document.getElementById('portal-copy-link-btn');
    if (portalCopyBtn) {
        portalCopyBtn.addEventListener('click', () => {
            const linkInput = document.getElementById('portal-referral-link');
            linkInput.select();
            navigator.clipboard.writeText(linkInput.value);
            showToast('¡Enlace de referido copiado al portapapeles!');
        });
    }

    const portalWhatsappShareBtn = document.getElementById('portal-whatsapp-share-btn');
    if (portalWhatsappShareBtn) {
        portalWhatsappShareBtn.addEventListener('click', () => {
            if (!currentAmbassador) return;
            const link = document.getElementById('portal-referral-link').value;
            const msg = encodeURIComponent(`¡Hola! Visita TinajitoStore y descubre miles de productos al mejor precio con mi enlace de referido y obtén descuentos exclusivos: ${link}`);
            window.open(`https://wa.me/?text=${msg}`, '_blank');
        });
    }
}

// --- LOGIN / LOGOUT DE ADMINISTRADOR (Supabase Auth) ---
function openAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    document.getElementById('admin-login-error').classList.add('hidden');
    document.getElementById('admin-login-form').reset();
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeAdminLoginModal() {
    const modal = document.getElementById('admin-login-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
}

async function handleAdminLogin(e) {
    e.preventDefault();
    const email = document.getElementById('admin-email').value.trim();
    const password = document.getElementById('admin-password').value;
    const errorDiv = document.getElementById('admin-login-error');
    if (errorDiv) errorDiv.classList.add('hidden');

    if (!supabase) {
        if (errorDiv) {
            errorDiv.textContent = 'Cliente de Supabase no inicializado.';
            errorDiv.classList.remove('hidden');
        }
        return;
    }

    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error || !data.session) {
            if (errorDiv) {
                errorDiv.textContent = 'Correo o contraseña incorrectos.';
                errorDiv.classList.remove('hidden');
            }
            return;
        }

        const allowed = await checkIsAdmin();
        if (!allowed) {
            await supabase.auth.signOut();
            if (errorDiv) {
                errorDiv.textContent = 'Esta cuenta no tiene permisos de administrador.';
                errorDiv.classList.remove('hidden');
            }
            return;
        }

        closeAdminLoginModal();
        switchView('admin');
    } catch (err) {
        console.error('Error en autenticación de admin:', err);
        if (errorDiv) {
            errorDiv.textContent = 'Error de conexión al iniciar sesión.';
            errorDiv.classList.remove('hidden');
        }
    }
}

// Comprueba, contra la base de datos (no contra nada guardado en el
// navegador), si el usuario con sesión iniciada está en la tabla admins.
async function checkIsAdmin() {
    if (!supabase) return false;
    const { data: sessionData } = await supabase.auth.getSession();
    if (!sessionData.session) return false;
    const { data, error } = await supabase
        .from('admins')
        .select('user_id')
        .eq('user_id', sessionData.session.user.id)
        .maybeSingle();
    return !error && !!data;
}

// --- VIEW SWITCHER ---
async function switchView(view) {
    const storeView = document.getElementById('store-view');
    const adminView = document.getElementById('admin-view');
    const portalView = document.getElementById('modalEmbajadores');

    if (storeView) { storeView.classList.add('hidden'); storeView.style.display = 'none'; }
    if (adminView) { adminView.classList.add('hidden'); adminView.style.display = 'none'; }
    if (portalView) { portalView.classList.add('hidden'); portalView.style.display = 'none'; }

    if (view === 'store') {
        if (storeView) { storeView.classList.remove('hidden'); storeView.style.display = 'flex'; }
        initStoreView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (view === 'admin') {
        // La comprobación real está en el servidor (políticas RLS): aunque
        // alguien manipulara esto desde la consola, no podría leer ni
        // escribir nada en las tablas protegidas sin una sesión válida de
        // una cuenta que esté en la tabla "admins".
        const allowed = await checkIsAdmin();
        if (!allowed) {
            switchView('store');
            return;
        }
        if (adminView) { adminView.classList.remove('hidden'); adminView.style.display = 'flex'; }
        initAdminView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    } else if (view === 'portal') {
        if (portalView) { portalView.classList.remove('hidden'); portalView.style.display = 'flex'; }
        initPortalView();
        window.scrollTo({ top: 0, behavior: 'smooth' });
    }
}

/* ==========================================
   MÓDULO: TIENDA PÚBLICA
   ========================================== */
// Determinar filtro de categoría inicial:
//  1) Si la URL trae ?cat=nombre (categorías nuevas creadas desde el admin) se usa ese.
//  2) Si no, y la página es una de las 4 con archivo propio, se usa su nombre.
//  3) Si no, "all" (index.html).
const pathName = window.location.pathname.split('/').pop().toLowerCase();
// Mapa { 'nombre categoría en minúsculas': 'archivo.html' }. Lo rellena solo generar-seo.py.
const KNOWN_CATEGORY_PAGES = {"⚡ energía y movilidad": "energia-y-movilidad.html", "🏡 hogar y utilidades": "hogar-y-utilidades.html", "👗 moda y ropa": "moda-y-ropa.html", "💻 tecnología y electrónica": "tecnologia-y-electronica.html", "🧴 cuidado personal y bienestar": "cuidado-personal-y-bienestar.html", "🛒 alimentos y víveres": "alimentos-y-viveres.html"};
const urlCatParam = (new URLSearchParams(window.location.search).get('cat') || '').trim().toLowerCase();
let initialCategoryFilter = 'all';
if (urlCatParam) initialCategoryFilter = urlCatParam;
else {
    const known = Object.keys(KNOWN_CATEGORY_PAGES).find(c => KNOWN_CATEGORY_PAGES[c] === pathName);
    if (known) initialCategoryFilter = known;
}

let currentCategoryFilter = initialCategoryFilter;
// Subcategoría pedida por la URL (?sub=paneles-solares). Solo se aplica si de verdad
// existe dentro de la categoría activa (ver getActiveSub), así un enlace viejo o mal
// escrito nunca deja la página vacía.
let requestedSubParam = (new URLSearchParams(window.location.search).get('sub') || '').trim().toLowerCase();

function initStoreView() {
    renderCategoryFilters();
    applySearchAndFilter(); // antes llamaba a renderProducts(products) sin filtrar: en audio.html, moda.html, etc. se veía SIEMPRE el catálogo completo, ignorando la categoría de la página.
    updateCartUI();
    if (activeAffiliate && document.getElementById('affiliate-input')) {
        document.getElementById('affiliate-input').value = activeAffiliate.codigo;
    }
}

// Solo la primera letra (ignorando emojis) va en mayúscula.
function prettyCat(c) { return String(c).replace(/\p{L}/u, ch => ch.toUpperCase()); }

function renderCategoryFilters() {
    const container = document.getElementById('category-filters-container');
    if (!container) return;

    const currentPath = window.location.pathname.split('/').pop() || 'index.html';

    const isTodosActive = currentCategoryFilter === 'all';
    let html = `<a href="index.html" class="category-filter-btn category-btn px-5 py-2 rounded-full text-xs sm:text-sm font-medium transition-all shrink-0 ${isTodosActive ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 border border-emerald-500' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'}">Todos</a>`;

    html += categories.map(cat => {
        const lowerCat = cat.toLowerCase();
        // Las categorías con página propia (generadas por generar-seo.py) enlazan a su .html;
        // el resto usa index.html?cat=nombre.
        const href = KNOWN_CATEGORY_PAGES[lowerCat] || `index.html?cat=${encodeURIComponent(lowerCat)}`;
        const isActive = currentCategoryFilter === lowerCat;
        return `
            <a href="${href}" class="category-filter-btn category-btn px-5 py-2 rounded-full text-xs sm:text-sm font-medium transition-all shrink-0 ${isActive ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 border border-emerald-500' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'}">
                ${escapeHtml(prettyCat(cat))}
            </a>
        `;
    }).join('');

    container.innerHTML = html;
    renderSubcategoryFilters();
}

// --- SUBCATEGORÍAS (segunda fila de filtros, solo aparece dentro de una categoría que las tenga) ---
function subcategoriesOf(cat) {
    const c = (cat || '').toLowerCase();
    return subcategories.filter(s => (s.category || '').toLowerCase() === c).map(s => s.name);
}

function getActiveSub() {
    if (currentCategoryFilter === 'all' || !requestedSubParam) return 'all';
    return subcategoriesOf(currentCategoryFilter).some(n => n.toLowerCase() === requestedSubParam) ? requestedSubParam : 'all';
}

function renderSubcategoryFilters() {
    const bar = document.getElementById('subcategory-bar');
    const container = document.getElementById('subcategory-filters-container');
    if (!bar || !container) return; // página con HTML sin actualizar: se omite sin romper nada

    const subs = currentCategoryFilter === 'all' ? [] : subcategoriesOf(currentCategoryFilter);
    if (subs.length === 0) {
        bar.classList.add('hidden');
        container.innerHTML = '';
        return;
    }

    const cat = currentCategoryFilter;
    const base = KNOWN_CATEGORY_PAGES[cat] || `index.html?cat=${encodeURIComponent(cat)}`;
    const sep = base.includes('?') ? '&' : '?';
    const active = getActiveSub();
    const on = 'bg-indigo-600 text-white border border-indigo-500 shadow-md shadow-indigo-600/20';
    const off = 'bg-slate-900 text-slate-300 border border-slate-800 hover:bg-slate-800';

    // Desktop view (pills)
    let desktopHtml = `<div class="hidden md:flex items-center justify-center space-x-2 py-1 min-w-max">`;
    desktopHtml += `<a href="${escapeHtml(base)}" class="px-4 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 ${active === 'all' ? on : off}">Todas</a>`;
    desktopHtml += subs.map(name => {
        const low = name.toLowerCase();
        const href = `${base}${sep}sub=${encodeURIComponent(low)}`;
        return `<a href="${escapeHtml(href)}" class="px-4 py-1.5 rounded-full text-xs font-medium transition-all shrink-0 capitalize ${active === low ? on : off}">${escapeHtml(name)}</a>`;
    }).join('');
    desktopHtml += `</div>`;

    // Mobile view (select dropdown)
    let mobileHtml = `<div class="block md:hidden w-full px-2 py-1">`;
    mobileHtml += `<select onchange="if(this.value){window.location.href=this.value;}" class="w-full bg-slate-900 border border-slate-800 text-slate-200 text-xs py-2 px-3 rounded-xl focus:outline-none focus:border-indigo-500 font-medium">`;
    mobileHtml += `<option value="${escapeHtml(base)}">📂 Todas las subcategorías</option>`;
    mobileHtml += subs.map(name => {
        const low = name.toLowerCase();
        const href = `${base}${sep}sub=${encodeURIComponent(low)}`;
        const selected = active === low ? 'selected' : '';
        return `<option value="${escapeHtml(href)}" ${selected}>${escapeHtml(name)}</option>`;
    }).join('');
    mobileHtml += `</select></div>`;

    container.innerHTML = desktopHtml + mobileHtml;
    bar.classList.remove('hidden');
}

function filterByCategory(category) {
    currentCategoryFilter = category;
    requestedSubParam = '';
    renderCategoryFilters();
    applySearchAndFilter();
}

function applySearchAndFilter() {
    const query = (document.getElementById('search-input')?.value || document.getElementById('search-input-mobile')?.value || '').toLowerCase().trim();

    const activeSub = getActiveSub();
    const filtered = products.filter(p => {
        const matchesCategory = currentCategoryFilter === 'all' || (p.category || '').toLowerCase() === currentCategoryFilter;
        const matchesSub = activeSub === 'all' || (p.subcategory || '').toLowerCase() === activeSub;
        const matchesQuery = (p.name || '').toLowerCase().includes(query) || (p.description || '').toLowerCase().includes(query);
        return matchesCategory && matchesSub && matchesQuery;
    });

    // Los agotados se muestran (marcados) pero al final de la lista.
    filtered.sort((a, b) => Number(isSoldOut(a)) - Number(isSoldOut(b)));
    renderProducts(filtered);
}

function renderProducts(productsToRender) {
    const grid = document.getElementById('products-grid');
    if (!grid) return;

    if (productsToRender.length === 0) {
        grid.innerHTML = `
            <div class="col-span-full text-center py-20 bg-slate-900 rounded-3xl border border-slate-800">
                <svg class="w-16 h-16 mx-auto text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"></path>
                </svg>
                <h3 class="text-base font-semibold text-slate-200">No se encontraron productos</h3>
                <p class="text-slate-400 text-sm mt-1">Intenta con otro término de búsqueda o categoría.</p>
            </div>
        `;
        return;
    }

    grid.innerHTML = productsToRender.map(product => {
        const soldOut = isSoldOut(product);
        const lowStock = !soldOut && product.stock !== null && product.stock !== undefined && product.stock <= LOW_STOCK_THRESHOLD;
        const imgAttrs = getResponsiveImageAttrs(product.image, 600);
        return `
        <div class="bg-slate-900 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 overflow-hidden flex flex-col group border border-slate-800 hover:border-slate-700">
            <div class="relative overflow-hidden bg-slate-950 aspect-square">
                <img src="${imgAttrs.src}" ${imgAttrs.srcset ? `srcset="${imgAttrs.srcset}" sizes="${imgAttrs.sizes}"` : ''} alt="${escapeHtml(product.name)}" width="300" height="300" loading="lazy" decoding="async" class="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-500 ${soldOut ? 'grayscale opacity-60' : ''}" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">
                ${soldOut ? `<span class="absolute top-3 left-3 bg-rose-600 text-white text-xs font-bold px-3 py-1 rounded-full shadow-md shadow-rose-600/30">Agotado</span>` : (product.badge ? `<span class="absolute top-3 left-3 bg-emerald-600 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-md shadow-emerald-600/30">${escapeHtml(product.badge)}</span>` : '')}
                ${lowStock ? `<span class="absolute bottom-3 left-3 bg-amber-500 text-slate-950 text-[11px] font-bold px-2.5 py-1 rounded-full">¡Últimas ${product.stock}!</span>` : ''}
                <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button onclick="quickView(${product.id})" class="bg-slate-900 text-slate-100 px-4 py-2 rounded-xl font-medium text-sm shadow-xl transform translate-y-3 group-hover:translate-y-0 transition-all duration-300 hover:bg-emerald-600 hover:text-white border border-slate-700">
                        Ver Detalles
                    </button>
                </div>
            </div>
            <div class="p-5 flex-1 flex flex-col justify-between">
                <div>
                    <span class="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">${escapeHtml(product.category)}${product.subcategory ? ' › ' + escapeHtml(product.subcategory) : ''}</span>
                    <h3 class="font-bold text-white text-base mt-1 group-hover:text-emerald-400 transition-colors line-clamp-1">${escapeHtml(product.name)}</h3>
                    <p class="text-slate-400 text-xs mt-1.5 line-clamp-2 leading-relaxed">${escapeHtml(product.description)}</p>
                </div>
                <div class="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between">
                    <div>
                        <span class="text-xl font-extrabold text-white">${priceHtml(product.price, product.currency)}</span>
                        ${product.originalPrice ? `<span class="text-xs text-slate-500 line-through ml-1.5">$${product.originalPrice.toFixed(2)}</span>` : ''}
                    </div>
                    ${soldOut ? `<button disabled aria-label="Producto agotado" class="bg-slate-800 text-slate-500 text-xs font-bold px-3 py-2.5 rounded-xl cursor-not-allowed border border-slate-700">Agotado</button>` : `<button onclick="addToCart(${product.id})" aria-label="Añadir al carrito" class="bg-emerald-600 hover:bg-emerald-500 text-white p-2.5 rounded-xl transition-all duration-300 shadow-md hover:shadow-lg flex items-center justify-center group/btn">
                        <svg class="w-5 h-5 transform group-hover/btn:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path>
                        </svg>
                    </button>`}
                </div>
            </div>
        </div>
    `;
    }).join('');
}

// --- STOCK ---
// stock === null -> sin control de stock (siempre disponible)
// stock === 0    -> agotado
// stock  >  0    -> unidades disponibles
const LOW_STOCK_THRESHOLD = 3;
function isSoldOut(p) { return !!p && p.stock !== null && p.stock !== undefined && p.stock <= 0; }
function stockLimit(p) { return (p && p.stock !== null && p.stock !== undefined) ? p.stock : Infinity; }

// Quita del carrito lo que se agotó y ajusta cantidades que superan el stock actual.
function reconcileCartWithStock() {
    let changed = false;
    cart = cart.filter(item => {
        const p = products.find(x => x.id === item.id);
        if (!p) return true;
        item.price = p.price;              // precio y moneda vigentes del catálogo
        item.currency = currencyOf(p);
        if (isSoldOut(p)) { changed = true; return false; }
        const limit = stockLimit(p);
        if (item.quantity > limit) { item.quantity = limit; changed = true; }
        return true;
    });
    setStorage('cart', cart);
    if (changed) {
        setTimeout(() => showToast('Actualizamos tu carrito: algunos productos se agotaron o tienen menos unidades'), 300);
    }
}

// Carrito Actions
function addToCart(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    if (isSoldOut(product)) {
        showToast(`${product.name} está agotado`);
        return;
    }

    const existingItem = cart.find(item => item.id === productId);
    if (existingItem) {
        if (existingItem.quantity + 1 > stockLimit(product)) {
            showToast(`Solo hay ${product.stock} unidad(es) disponibles de ${product.name}`);
            return;
        }
        existingItem.quantity += 1;
    } else {
        cart.push({ ...product, quantity: 1 });
    }

    setStorage('cart', cart);
    updateCartUI();
    showToast(`¡${product.name} añadido al carrito!`);
}

function updateQuantity(productId, delta) {
    const itemIndex = cart.findIndex(item => item.id === productId);
    if (itemIndex > -1) {
        const prod = products.find(p => p.id === productId);
        if (delta > 0 && prod && cart[itemIndex].quantity + delta > stockLimit(prod)) {
            showToast(`Solo hay ${prod.stock} unidad(es) disponibles`);
            return;
        }
        cart[itemIndex].quantity += delta;
        if (cart[itemIndex].quantity <= 0) {
            cart.splice(itemIndex, 1);
        }
    }
    setStorage('cart', cart);
    updateCartUI();
}

function removeFromCart(productId) {
    cart = cart.filter(item => item.id !== productId);
    setStorage('cart', cart);
    updateCartUI();
}

function toggleCart() {
    const cartDrawer = document.getElementById('cart-drawer');
    const cartOverlay = document.getElementById('cart-overlay');
    const isOpen = cartDrawer.classList.contains('translate-x-0');
    if (isOpen) {
        cartDrawer.classList.remove('translate-x-0');
        cartDrawer.classList.add('translate-x-full');
        cartOverlay.classList.add('opacity-0', 'pointer-events-none');
        cartOverlay.classList.remove('opacity-100');
    } else {
        cartDrawer.classList.remove('translate-x-full');
        cartDrawer.classList.add('translate-x-0');
        cartOverlay.classList.remove('opacity-0', 'pointer-events-none');
        cartOverlay.classList.add('opacity-100');
    }
}

// Limpia el código de afiliado activo (se llama al completar o cancelar
// una compra, para que no quede "pegado" a la siguiente visita/carrito).
function clearActiveAffiliate() {
    activeAffiliate = null;
    setStorage('active_affiliate', null);
    const input = document.getElementById('affiliate-input');
    const feedback = document.getElementById('affiliate-feedback');
    if (input) input.value = '';
    if (feedback) feedback.classList.add('hidden');
}

// Aplicar Afiliado (consulta pública: código, nombre y descuento)
async function applyAffiliateFromInput() {
    const code = document.getElementById('affiliate-input').value.toUpperCase().trim();
    const feedback = document.getElementById('affiliate-feedback');

    if (!code) {
        activeAffiliate = null;
        setStorage('active_affiliate', null);
        feedback.textContent = "Ingresa un código válido.";
        feedback.className = "mt-2 text-xs font-medium text-rose-400";
        feedback.classList.remove('hidden');
        updateCartUI();
        return;
    }

    const found = await fetchPublicAffiliate(code);
    if (found) {
        activeAffiliate = found;
        setStorage('active_affiliate', activeAffiliate);
        feedback.textContent = '¡Código aplicado con éxito!';
        feedback.className = "mt-2 text-xs font-medium text-emerald-400";
        feedback.classList.remove('hidden');
        updateCartUI();
    } else {
        activeAffiliate = null;
        setStorage('active_affiliate', null);
        feedback.textContent = "Código de afiliado inválido.";
        feedback.className = "mt-2 text-xs font-medium text-rose-400";
        feedback.classList.remove('hidden');
        updateCartUI();
    }
}

// Actualizar Carrito UI
function updateCartUI() {
    const totalCount = cart.reduce((sum, item) => sum + item.quantity, 0);
    const totals = cartTotals();
    const anyDiscount = CURRENCY_ORDER.some(c => totals[c] && totals[c].discount > 0);
    const discountRow = document.getElementById('discount-row');
    const discountLabel = document.getElementById('discount-label');
    const cartDiscountEl = document.getElementById('cart-discount');
    const feedback = document.getElementById('affiliate-feedback');
    const cartCountBadge = document.getElementById('cart-count');

    if (activeAffiliate) {
        discountRow.classList.remove('hidden');
        discountLabel.textContent = `Descuento (${activeAffiliate.codigo} · ${Number(activeAffiliate.descuento || 0)}%)`;
        cartDiscountEl.textContent = joinCurrencyTotals(totals, 'discount', '-');

        const input = document.getElementById('affiliate-input');
        if (input && input.value !== activeAffiliate.codigo) {
            input.value = activeAffiliate.codigo;
        }
        feedback.textContent = anyDiscount ? `¡Código aplicado! Ahorras ${joinCurrencyTotals(totals, 'discount')}` : '¡Código aplicado!';
        feedback.className = "mt-2 text-xs font-medium text-emerald-400";
        feedback.classList.remove('hidden');
    } else {
        discountRow.classList.add('hidden');
    }

    if (totalCount > 0) {
        cartCountBadge.textContent = totalCount;
        cartCountBadge.classList.remove('hidden');
    } else {
        cartCountBadge.classList.add('hidden');
    }

    document.getElementById('cart-subtotal').textContent = joinCurrencyTotals(totals, 'subtotal');
    document.getElementById('cart-total').textContent = joinCurrencyTotals(totals, 'total');

    const itemsContainer = document.getElementById('cart-items');
    const emptyMsg = document.getElementById('empty-cart-msg');
    const footer = document.getElementById('cart-footer');

    if (cart.length === 0) {
        emptyMsg.classList.remove('hidden');
        footer.classList.add('hidden');
        itemsContainer.innerHTML = `
            <div id="empty-cart-msg" class="text-center py-20">
                <svg class="w-16 h-16 mx-auto text-slate-600 mb-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path>
                </svg>
                <p class="text-slate-300 font-semibold">Tu carrito está vacío</p>
                <p class="text-xs text-slate-500 mt-1">Explora el catálogo y añade productos</p>
            </div>
        `;
    } else {
        emptyMsg.classList.add('hidden');
        footer.classList.remove('hidden');

        itemsContainer.innerHTML = cart.map(item => {
            const cartImgAttrs = getResponsiveImageAttrs(item.image, 120);
            return `
            <div class="flex items-center space-x-3.5 bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800">
                <img src="${cartImgAttrs.src}" ${cartImgAttrs.srcset ? `srcset="${cartImgAttrs.srcset}" sizes="${cartImgAttrs.sizes}"` : ''} alt="${escapeHtml(item.name)}" width="64" height="64" loading="lazy" decoding="async" class="w-16 h-16 object-cover rounded-xl bg-slate-900 shadow-xs border border-slate-800" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">
                <div class="flex-1 min-w-0">
                    <h4 class="font-semibold text-white text-xs truncate">${escapeHtml(item.name)}</h4>
                    <p class="text-emerald-400 font-bold text-xs mt-0.5">${priceHtml(item.price, cartItemCurrency(item))}</p>
                    <div class="flex items-center justify-between mt-2.5">
                        <div class="flex items-center space-x-2 bg-slate-900 border border-slate-800 rounded-lg px-2 py-0.5 shadow-xs">
                            <button onclick="updateQuantity(${item.id}, -1)" class="text-slate-400 hover:text-emerald-400 font-bold px-1 transition-colors">-</button>
                            <span class="text-xs font-semibold text-white w-5 text-center">${item.quantity}</span>
                            <button onclick="updateQuantity(${item.id}, 1)" class="text-slate-400 hover:text-emerald-400 font-bold px-1 transition-colors">+</button>
                        </div>
                        <button onclick="removeFromCart(${item.id})" class="text-slate-400 hover:text-rose-400 p-1 transition-colors">
                            <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path>
                            </svg>
                        </button>
                    </div>
                </div>
            </div>
        `;
        }).join('');
    }
}

// WhatsApp Order
async function sendWhatsAppOrder(e) {
    e.preventDefault();
    const name = document.getElementById('client-name').value.trim();
    const phone = document.getElementById('client-phone').value.trim();
    const address = document.getElementById('client-address').value.trim();
    const payment = document.getElementById('client-payment').value;

    if (cart.length === 0) return;

    // Totales por moneda: USD y CUP nunca se suman entre sí.
    const totals = cartTotals();
    const anyDiscount = CURRENCY_ORDER.some(c => totals[c] && totals[c].discount > 0);

    const itemsText = cart.map((item, index) => {
        const cur = cartItemCurrency(item);
        const itemTotal = item.price * item.quantity;
        return `*${index + 1}. ${item.name}* \n   Cant: ${item.quantity} \n   Precio: ${fmtMoney(item.price, cur)} \n   Subtotal: *${fmtMoney(itemTotal, cur)}*`;
    }).join('\n\n');

    let affiliateInfoText = "";
    if (activeAffiliate) {
        affiliateInfoText = `🏷️ *Afiliado / Referido:* ${activeAffiliate.nombre}\n` +
                            `🔑 *Código:* ${activeAffiliate.codigo}\n` +
                            `📉 *Descuento Aplicado:* ${joinCurrencyTotals(totals, 'discount', '-')}\n`;
    }

    // Referencia única del pedido: viaja en el mensaje de WhatsApp Y se guarda en "sales".
    // Se registra UN pedido por moneda. El de pesos usa la referencia base; el de dólares
    // lleva el sufijo "-USD", y así el panel sabe en qué moneda está cada venta.
    const orderRef = buildOrderReference();
    const groups = {};
    cart.forEach(item => { const cur = cartItemCurrency(item); (groups[cur] = groups[cur] || []).push(item); });
    const currencies = CURRENCY_ORDER.filter(c => groups[c]);
    const refFor = cur => cur === 'USD' ? `${orderRef}-USD` : orderRef;
    const refsText = currencies.map(refFor).join(' / ');

    const salePromises = currencies.map(cur => submitSaleWithRetry({
        p_codigo: activeAffiliate ? activeAffiliate.codigo : null,
        p_cliente: name || 'Cliente General',
        p_items: groups[cur].map(item => ({ id: item.id, quantity: item.quantity })),
        p_order_ref: refFor(cur),
        p_telefono: phone,
        p_direccion: address,
        p_pago: payment
    }));

    const itemsCount = cart.reduce((acc, item) => acc + item.quantity, 0);

    const message = `🛍️ *NUEVO PEDIDO — TINAJITOSTORE*\n` +
        `🔖 *Referencia:* ${refsText}\n` +
        (currencies.length > 1 ? `ℹ️ Incluye productos en 2 monedas: se registró una referencia por moneda.\n` : '') +
        `\n👤 *${name}*\n` +
        `📱 ${phone}\n` +
        `📍 ${address}\n` +
        `💳 *Pago:* ${payment}\n` +
        (affiliateInfoText ? `\n${affiliateInfoText}` : '') +
        `\n-----------------------------------\n` +
        `📦 *DETALLE (${itemsCount} artículo${itemsCount === 1 ? '' : 's'}):*\n\n${itemsText}\n\n` +
        `-----------------------------------\n` +
        (anyDiscount ? `Subtotal: ${joinCurrencyTotals(totals, 'subtotal')}\nDescuento: ${joinCurrencyTotals(totals, 'discount', '-')}\n` : '') +
        `💰 *TOTAL: ${joinCurrencyTotals(totals, 'total')}*\n\n` +
        `¡Hola! Quiero confirmar este pedido (Ref. ${refsText}). Quedo atento 🙌`;

    const whatsappUrl = `https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

    // 1) Procesar el registro de las ventas en Supabase de forma limpia primero
    const results = await Promise.all(salePromises);
    if (results.some(ok => !ok)) {
        showToast('El pedido se procesó localmente, pero hubo un problema al sincronizar con el servidor. Se reintentará.');
    }

    // 2) Limpieza de la interfaz
    try {
        document.getElementById('checkout-modal').classList.add('hidden');
        document.getElementById('checkout-modal').classList.remove('flex');

        // El carrito se vacía porque el pedido ya quedó armado en el mensaje;
        // si el cliente vuelve, no debería reencontrarse el mismo pedido "a medias".
        // El código de afiliado tampoco debe seguir aplicado a la siguiente compra.
        cart = [];
        setStorage('cart', cart);
        clearActiveAffiliate();
        updateCartUI();
        const drawer = document.getElementById('cart-drawer');
        if (drawer && drawer.classList.contains('translate-x-0')) toggleCart();
    } catch (err) {
        console.error('Error limpiando la interfaz tras el pedido:', err);
    }

    // 3) Redirección segura según dispositivo (móvil vs escritorio)
    const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    if (isMobile) {
        window.location.href = whatsappUrl;
    } else {
        let waWindow = null;
        try { waWindow = window.open(whatsappUrl, '_blank'); } catch (err) { console.error('window.open falló:', err); }
        const blocked = !waWindow || waWindow.closed;
        showOrderConfirmation(refsText, whatsappUrl, blocked);
    }
}

// --- REGISTRO DE PEDIDOS CON REINTENTO ---
// Si record_sale falla (sin conexión, error temporal), el pedido se guarda en
// el navegador y se reintenta al abrir la tienda. Como cada pedido lleva su
// order_ref único, reintentar NUNCA duplica una venta.
async function submitSaleWithRetry(payload) {
    try {
        const { error } = await supabase.rpc('record_sale', payload);
        if (error) throw error;
        return true;
    } catch (err) {
        console.error('No se pudo registrar el pedido ' + payload.p_order_ref + ':', err.message || err);
        const queue = getStorage('pending_sales', []);
        if (!queue.some(q => q.p_order_ref === payload.p_order_ref)) {
            queue.push(payload);
            setStorage('pending_sales', queue);
        }
        return false;
    }
}

async function flushPendingSales() {
    if (!supabase) return;
    const queue = getStorage('pending_sales', []);
    if (queue.length === 0) return;
    const remaining = [];
    for (const payload of queue) {
        const { error } = await supabase.rpc('record_sale', payload);
        // Errores definitivos (producto borrado, código inexistente) se descartan para no reintentar eternamente.
        const definitive = error && /no existe|no encontrado|no tiene productos/i.test(error.message || '');
        if (error && !definitive) remaining.push(payload);
    }
    setStorage('pending_sales', remaining);
}

// Referencia corta y legible: TJ-AAMMDD-XXXX
function buildOrderReference() {
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const datePart = `${String(d.getFullYear()).slice(2)}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
    const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
    return `TJ-${datePart}-${rand}`;
}

// Pantalla simple de "pedido enviado" tras abrir WhatsApp.
function showOrderConfirmation(orderRef) {
    const modal = document.getElementById('order-confirmation-modal');
    if (!modal) return;
    document.getElementById('order-confirmation-ref').textContent = orderRef;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
}

function closeOrderConfirmation() {
    const modal = document.getElementById('order-confirmation-modal');
    if (modal) {
        modal.classList.add('hidden');
        modal.classList.remove('flex');
    }
}

function showToast(text) {
    const toast = document.getElementById('notification-toast');
    toast.querySelector('#toast-text').textContent = text;
    toast.classList.remove('translate-y-20', 'opacity-0');
    toast.classList.add('translate-y-0', 'opacity-100');
    setTimeout(() => {
        toast.classList.remove('translate-y-0', 'opacity-100');
        toast.classList.add('translate-y-20', 'opacity-0');
    }, 3000);
}

function quickView(productId) {
    const p = products.find(x => x.id === productId);
    if (p) alert(`${p.name}\n\n${p.description}\n\nPrecio: ${fmtMoney(p.price, p.currency)}${isSoldOut(p) ? '\n\n⛔ AGOTADO' : (p.stock !== null && p.stock !== undefined ? `\n\nDisponibles: ${p.stock}` : '')}`);
}

// ==========================================
// VIDEO DEL BANNER: carga diferida y con criterio
// ==========================================
// El <video> llega desde el HTML SIN autoplay y con preload="none": el
// <source> real vive en data-src, así que por defecto el navegador no baja
// ni un byte del mp4 y lo único que se ve es el poster (la misma imagen del
// logo, que ya se precarga con fetchpriority="high"). Esta función decide,
// una vez que la página ya cargó, si vale la pena bajar el video:
//   - Si el visitante pidió "reducir movimiento" (accesibilidad) o tiene
//     activado el modo ahorro de datos / una conexión lenta (2G/3G), el
//     video NUNCA se pide: se queda en la imagen fija y ya.
//   - Si no, se espera a que la página termine de cargar (evento "load") y
//     recién ahí se pide el mp4, para no competir por ancho de banda con
//     fuentes, imágenes y el catálogo que vienen de Supabase.
//   - Una vez reproduciéndose, se pausa solo (ahorra batería y CPU, no ya
//     datos) cuando la pestaña queda oculta o cuando el usuario baja el
//     scroll y el Hero sale de la pantalla; se reanuda al volver.
(function setupHeroVideoLazyLoad() {
    const video = document.getElementById('hero-video');
    if (!video) return;

    const source = video.querySelector('source[data-src]');
    if (!source) return; // ya tiene src real (o el HTML no trae este bloque): no hay nada que diferir

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const conn = navigator.connection || navigator.webkitConnection || navigator.mozConnection;
    const isSlowOrDataSaver = !!conn && (conn.saveData || ['slow-2g', '2g', '3g'].includes(conn.effectiveType));

    if (prefersReducedMotion || isSlowOrDataSaver) {
        return; // se queda en el poster, sin gastar datos en el video
    }

    let shouldBePlaying = false;
    let started = false;

    function startLoading() {
        if (started) return;
        started = true;

        // Red de seguridad: si el mp4 falla (ruta incorrecta, 404, o el
        // navegador nunca dispara "canplaythrough"), el <video> se queda
        // con opacity-0 para siempre y no se ve ni el poster. Estos
        // listeners garantizan que, pase lo que pase, la capa se revele.
        const reveal = () => video.classList.remove('opacity-0');
        video.addEventListener('canplaythrough', reveal, { once: true });
        video.addEventListener('loadeddata', reveal, { once: true });
        video.addEventListener('error', reveal, { once: true });
        source.addEventListener('error', reveal, { once: true });
        setTimeout(reveal, 4000); // último recurso si ningún evento llegó a disparar

        source.src = source.dataset.src;
        video.load();
        shouldBePlaying = true;
        video.play().catch(() => { /* autoplay bloqueado por el navegador: se queda en el poster, sin error visible */ });
    }

    // Espera a que termine de cargar todo lo demás (fuentes, imágenes, el
    // catálogo) antes de sumar la descarga del video a la cola de red.
    if (document.readyState === 'complete') {
        startLoading();
    } else {
        window.addEventListener('load', startLoading, { once: true });
    }

    // Pausar/reanudar según visibilidad de la pestaña.
    document.addEventListener('visibilitychange', () => {
        if (!started) return;
        if (document.hidden) video.pause();
        else if (shouldBePlaying) video.play().catch(() => {});
    });

    // Pausar/reanudar según si el Hero está en pantalla (ahorra batería/CPU
    // mientras el visitante mira el catálogo más abajo).
    if ('IntersectionObserver' in window) {
        const observer = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (!started) return;
                if (entry.isIntersecting) {
                    if (shouldBePlaying && !document.hidden) video.play().catch(() => {});
                } else {
                    video.pause();
                }
            });
        }, { threshold: 0.1 });
        observer.observe(video);
    }
})();

// ==========================================
// VIDEO DEL BANNER: fundido para disimular el corte del loop
// ==========================================
(function setupHeroVideoLoopFade() {
    const video = document.getElementById('hero-video');
    const fadeLayer = document.getElementById('hero-video-loop-fade');
    if (!video || !fadeLayer) return;

    const FADE_DURATION = 0.6;
    let rafId = null;

    function updateFade() {
        const duration = video.duration;
        if (duration && isFinite(duration)) {
            const t = video.currentTime;
            let progress = 0;

            if (t > duration - FADE_DURATION) {
                progress = (t - (duration - FADE_DURATION)) / FADE_DURATION;
            } else if (t < FADE_DURATION) {
                progress = 1 - (t / FADE_DURATION);
            }

            fadeLayer.style.opacity = Math.max(0, Math.min(1, progress)).toFixed(3);
        }
        rafId = requestAnimationFrame(updateFade);
    }

    video.addEventListener('loadedmetadata', () => {
        if (!rafId) rafId = requestAnimationFrame(updateFade);
    });

    if (video.readyState >= 1) {
        rafId = requestAnimationFrame(updateFade);
    }
})();


// --- MENÚ HAMBURGUESA (móvil) ---
(function initMobileMenu() {
    function setup() {
        const btn = document.getElementById('menu-toggle');
        const panel = document.getElementById('mobile-menu-panel');
        if (!btn || !panel) return;
        const iconOpen = document.getElementById('menu-icon-open');
        const iconClose = document.getElementById('menu-icon-close');
        function setOpen(open) {
            panel.classList.toggle('hidden', !open);
            btn.setAttribute('aria-expanded', String(open));
            btn.setAttribute('aria-label', open ? 'Cerrar menú de categorías' : 'Abrir menú de categorías');
            if (iconOpen) iconOpen.classList.toggle('hidden', open);
            if (iconClose) iconClose.classList.toggle('hidden', !open);
        }
        btn.addEventListener('click', () => setOpen(panel.classList.contains('hidden')));
        document.addEventListener('keydown', e => { if (e.key === 'Escape') setOpen(false); });
        window.matchMedia('(min-width: 768px)').addEventListener('change', e => { if (e.matches) setOpen(false); });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', setup);
    else setup();
})();
