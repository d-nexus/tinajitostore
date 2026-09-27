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
        if (refCode) {
            const found = await fetchPublicAffiliate(refCode);
            if (found) {
                activeAffiliate = found;
                setStorage('active_affiliate', activeAffiliate);
                updateCartUI();
            }
        }
    } catch (err) {
        console.error('Error al procesar enlace de referido:', err);
    }
}

async function loadCatalog() {
    if (!supabase) {
        showConnectionError('Falta configurar la conexión a la base de datos en config.js');
        initStoreView();
        return;
    }

    try {
        const timeoutPromise = new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout al conectar con Supabase')), 8000)
        );

        const fetchPromise = Promise.all([
            supabase.from('categories').select('name').order('name'),
            supabase.from('products').select('*').order('id')
        ]);

        const [{ data: cats, error: catErr }, { data: prods, error: prodErr }] = await Promise.race([
            fetchPromise,
            timeoutPromise
        ]);

        if (catErr) console.error('Error cargando categorías:', catErr.message);
        if (prodErr) console.error('Error cargando productos:', prodErr.message);

        categories = (cats || []).map(c => c.name);
        products = (prods || []).map(p => ({
            id: p.id,
            name: p.name,
            category: p.category,
            price: Number(p.price),
            originalPrice: p.original_price !== null ? Number(p.original_price) : null,
            image: p.image,
            description: p.description,
            badge: p.badge
        }));

        initStoreView();
    } catch (err) {
        console.error('Error al cargar catálogo:', err);
        showConnectionError('No se pudo establecer conexión con Supabase. Puedes interactuar con la interfaz visual y el carrito localmente.');
        initStoreView();
    }
}

// Datos públicos de un afiliado (para mostrar el % de descuento en el
// carrito). Nunca expone el PIN ni la comisión.
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

// --- CONFIGURACIÓN DE EVENTOS GLOBALES ---
function setupGlobalEvents() {
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

    document.getElementById('add-category-btn').addEventListener('click', openCategoryModal);
    document.getElementById('category-form').addEventListener('submit', handleSaveCategory);

    document.getElementById('add-affiliate-btn').addEventListener('click', () => openAffiliateModal());
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
// Determinar filtro de categoría inicial según la página actual
const pathName = window.location.pathname.split('/').pop().toLowerCase();
let initialCategoryFilter = 'all';
if (pathName.includes('accesorios')) initialCategoryFilter = 'accesorios';
else if (pathName.includes('audio')) initialCategoryFilter = 'audio';
else if (pathName.includes('moda')) initialCategoryFilter = 'moda';
else if (pathName.includes('tecnologia')) initialCategoryFilter = 'tecnologia';

let currentCategoryFilter = initialCategoryFilter;

function initStoreView() {
    renderCategoryFilters();
    renderProducts(products);
    updateCartUI();
    if (activeAffiliate && document.getElementById('affiliate-input')) {
        document.getElementById('affiliate-input').value = activeAffiliate.codigo;
    }
}

function renderCategoryFilters() {
    const container = document.getElementById('category-filters-container');
    if (!container) return;

    const currentPath = window.location.pathname.split('/').pop() || 'index.html';

    const isTodosActive = currentPath === '' || currentPath === 'index.html';
    let html = `<a href="index.html" class="category-filter-btn category-btn px-5 py-2 rounded-full text-xs sm:text-sm font-medium transition-all shrink-0 ${isTodosActive ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 border border-emerald-500' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'}">Todos</a>`;

    const categoryFiles = {
        'accesorios': 'accesorios.html',
        'audio': 'audio.html',
        'moda': 'moda.html',
        'tecnologia': 'tecnologia.html'
    };

    html += categories.map(cat => {
        const lowerCat = cat.toLowerCase();
        const fileName = categoryFiles[lowerCat] || `${lowerCat}.html`;
        const isActive = currentPath === fileName;
        return `
            <a href="${fileName}" class="category-filter-btn category-btn px-5 py-2 rounded-full text-xs sm:text-sm font-medium transition-all shrink-0 capitalize ${isActive ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-600/30 border border-emerald-500' : 'bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/20'}">
                ${escapeHtml(cat)}
            </a>
        `;
    }).join('');

    container.innerHTML = html;
}

function filterByCategory(category) {
    currentCategoryFilter = category;
    renderCategoryFilters();
    applySearchAndFilter();
}

function applySearchAndFilter() {
    const query = (document.getElementById('search-input')?.value || document.getElementById('search-input-mobile')?.value || '').toLowerCase().trim();

    const filtered = products.filter(p => {
        const matchesCategory = currentCategoryFilter === 'all' || p.category === currentCategoryFilter;
        const matchesQuery = p.name.toLowerCase().includes(query) || p.description.toLowerCase().includes(query);
        return matchesCategory && matchesQuery;
    });

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

    grid.innerHTML = productsToRender.map(product => `
        <div class="bg-slate-900 rounded-2xl shadow-xl hover:shadow-2xl transition-all duration-300 overflow-hidden flex flex-col group border border-slate-800 hover:border-slate-700">
            <div class="relative overflow-hidden bg-slate-950 aspect-square">
                <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.name)}" loading="lazy" class="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-500" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">
                ${product.badge ? `<span class="absolute top-3 left-3 bg-emerald-600 text-white text-xs font-semibold px-3 py-1 rounded-full shadow-md shadow-emerald-600/30">${escapeHtml(product.badge)}</span>` : ''}
                <div class="absolute inset-0 bg-slate-950/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
                    <button onclick="quickView(${product.id})" class="bg-slate-900 text-slate-100 px-4 py-2 rounded-xl font-medium text-sm shadow-xl transform translate-y-3 group-hover:translate-y-0 transition-all duration-300 hover:bg-emerald-600 hover:text-white border border-slate-700">
                        Ver Detalles
                    </button>
                </div>
            </div>
            <div class="p-5 flex-1 flex flex-col justify-between">
                <div>
                    <span class="text-[11px] font-semibold text-emerald-400 uppercase tracking-wider">${escapeHtml(product.category)}</span>
                    <h3 class="font-bold text-white text-base mt-1 group-hover:text-emerald-400 transition-colors line-clamp-1">${escapeHtml(product.name)}</h3>
                    <p class="text-slate-400 text-xs mt-1.5 line-clamp-2 leading-relaxed">${escapeHtml(product.description)}</p>
                </div>
                <div class="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between">
                    <div>
                        <span class="text-xl font-extrabold text-white">$${product.price.toFixed(2)}</span>
                        ${product.originalPrice ? `<span class="text-xs text-slate-500 line-through ml-1.5">$${product.originalPrice.toFixed(2)}</span>` : ''}
                    </div>
                    <button onclick="addToCart(${product.id})" class="bg-emerald-600 hover:bg-emerald-500 text-white p-2.5 rounded-xl transition-all duration-300 shadow-md hover:shadow-lg flex items-center justify-center group/btn">
                        <svg class="w-5 h-5 transform group-hover/btn:scale-110 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z"></path>
                        </svg>
                    </button>
                </div>
            </div>
        </div>
    `).join('');
}

// Carrito Actions
function addToCart(productId) {
    const product = products.find(p => p.id === productId);
    if (!product) return;

    const existingItem = cart.find(item => item.id === productId);
    if (existingItem) {
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

// Aplicar Afiliado (consulta pública: solo código, nombre y % de descuento)
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
        feedback.textContent = `¡Descuento aplicado con éxito! (${activeAffiliate.descuento}% OFF)`;
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
    const subtotal = cart.reduce((sum, item) => sum + (item.price * item.quantity), 0);

    let discountAmount = 0;
    const discountRow = document.getElementById('discount-row');
    const discountLabel = document.getElementById('discount-label');
    const cartDiscountEl = document.getElementById('cart-discount');
    const feedback = document.getElementById('affiliate-feedback');
    const cartCountBadge = document.getElementById('cart-count');

    if (activeAffiliate) {
        discountAmount = (subtotal * activeAffiliate.descuento) / 100;
        discountRow.classList.remove('hidden');
        discountLabel.textContent = `Descuento (${activeAffiliate.codigo} - ${activeAffiliate.descuento}%)`;
        cartDiscountEl.textContent = `-$${discountAmount.toFixed(2)}`;

        const input = document.getElementById('affiliate-input');
        if (input && input.value !== activeAffiliate.codigo) {
            input.value = activeAffiliate.codigo;
        }
        feedback.textContent = `¡Descuento aplicado con éxito! (${activeAffiliate.descuento}% OFF)`;
        feedback.className = "mt-2 text-xs font-medium text-emerald-400";
        feedback.classList.remove('hidden');
    } else {
        discountRow.classList.add('hidden');
    }

    const finalTotal = Math.max(0, subtotal - discountAmount);

    if (totalCount > 0) {
        cartCountBadge.textContent = totalCount;
        cartCountBadge.classList.remove('hidden');
    } else {
        cartCountBadge.classList.add('hidden');
    }

    document.getElementById('cart-subtotal').textContent = `$${subtotal.toFixed(2)}`;
    document.getElementById('cart-total').textContent = `$${finalTotal.toFixed(2)}`;

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

        itemsContainer.innerHTML = cart.map(item => `
            <div class="flex items-center space-x-3.5 bg-slate-950/60 p-3.5 rounded-2xl border border-slate-800">
                <img src="${escapeHtml(item.image)}" alt="${escapeHtml(item.name)}" loading="lazy" class="w-16 h-16 object-cover rounded-xl bg-slate-900 shadow-xs border border-slate-800" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">
                <div class="flex-1 min-w-0">
                    <h4 class="font-semibold text-white text-xs truncate">${escapeHtml(item.name)}</h4>
                    <p class="text-emerald-400 font-bold text-xs mt-0.5">$${item.price.toFixed(2)}</p>
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
        `).join('');
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

    let subtotal = 0;
    let itemsText = cart.map((item, index) => {
        const itemTotal = item.price * item.quantity;
        subtotal += itemTotal;
        return `*${index + 1}. ${item.name}* \n   Cant: ${item.quantity} \n   Precio: $${item.price.toFixed(2)} \n   Subtotal: *$${itemTotal.toFixed(2)}*`;
    }).join('\n\n');

    let discountAmount = 0;
    let affiliateInfoText = "";

    if (activeAffiliate) {
        discountAmount = (subtotal * activeAffiliate.descuento) / 100;
        affiliateInfoText = `🏷️ *Afiliado / Referido:* ${activeAffiliate.nombre}\n` +
                            `🔑 *Código:* ${activeAffiliate.codigo} (${activeAffiliate.descuento}% OFF)\n` +
                            `📉 *Descuento Aplicado:* -$${discountAmount.toFixed(2)}\n`;

        // El registro real de la venta y su comisión ocurre en el servidor
        // (record_sale), que vuelve a calcular todo con los precios y el %
        // guardados en la base de datos: el navegador no puede inflar esto.
        const { error } = await supabase.rpc('record_sale', {
            p_codigo: activeAffiliate.codigo,
            p_cliente: name || 'Cliente General',
            p_items: cart.map(item => ({ id: item.id, quantity: item.quantity }))
        });
        if (error) {
            console.error('No se pudo registrar la comisión del afiliado:', error.message);
        }
    }

    const finalTotal = Math.max(0, subtotal - discountAmount);

    const message = `🛍️ *NUEVO PEDIDO - TINAJITOSTORE* 🛍️\n\n` +
        `👤 *Cliente:* ${name}\n` +
        `📱 *Teléfono:* ${phone}\n` +
        `📍 *Dirección:* ${address}\n` +
        `💳 *Pago:* ${payment}\n` +
        (affiliateInfoText ? `\n${affiliateInfoText}` : '') +
        `\n-----------------------------------\n` +
        `📦 *DETALLE DEL PEDIDO:*\n\n${itemsText}\n\n` +
        `-----------------------------------\n` +
        `💰 *TOTAL FINAL: $${finalTotal.toFixed(2)}*\n\n` +
        `¡Hola! Me gustaría confirmar este pedido. Quedo atento.`;

    const whatsappUrl = `https://wa.me/${STORE_WHATSAPP_NUMBER}?text=${encodeURIComponent(message)}`;

    document.getElementById('checkout-modal').classList.add('hidden');
    document.getElementById('checkout-modal').classList.remove('flex');
    window.open(whatsappUrl, '_blank');
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
    if (p) alert(`${p.name}\n\n${p.description}\n\nPrecio: $${p.price.toFixed(2)}`);
}

/* ==========================================
   MÓDULO: PANEL ADMINISTRATIVO INTEGRAL
   ========================================== */
let editingProductId = null;
let editingAffiliateId = null;
let lastAdminAffiliates = [];

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
async function renderAdminDashboard() {
    const { data, error } = await supabase.from('sales').select('*').order('fecha', { ascending: false });
    if (error) {
        console.error('Error cargando ventas:', error.message);
        return;
    }
    salesHistory = data || [];

    const totalSalesCount = salesHistory.length;
    const totalRevenue = salesHistory.reduce((acc, s) => acc + Number(s.monto_venta), 0);
    const totalCommissions = salesHistory.reduce((acc, s) => acc + Number(s.comision_ganada), 0);

    document.getElementById('stat-total-sales').textContent = totalSalesCount;
    document.getElementById('stat-total-revenue').textContent = `$${totalRevenue.toFixed(2)}`;
    document.getElementById('stat-total-commissions').textContent = `$${totalCommissions.toFixed(2)}`;

    const statsByCode = {};
    salesHistory.forEach(s => {
        if (!statsByCode[s.codigo]) {
            statsByCode[s.codigo] = { nombre: s.nombre, count: 0, revenue: 0, commission: 0 };
        }
        statsByCode[s.codigo].count += 1;
        statsByCode[s.codigo].revenue += Number(s.monto_venta);
        statsByCode[s.codigo].commission += Number(s.comision_ganada);
    });

    const tableBody = document.getElementById('sales-report-table');
    const keys = Object.keys(statsByCode);

    if (keys.length === 0) {
        tableBody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">No hay ventas registradas con códigos de afiliados aún.</td></tr>`;
        return;
    }

    tableBody.innerHTML = keys.map(code => {
        const item = statsByCode[code];
        return `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="px-6 py-4 font-mono font-bold text-white">${escapeHtml(code)}</td>
                <td class="px-6 py-4 text-slate-300 font-medium">${escapeHtml(item.nombre)}</td>
                <td class="px-6 py-4 text-slate-400 text-center">${item.count}</td>
                <td class="px-6 py-4 text-white font-bold">$${item.revenue.toFixed(2)}</td>
                <td class="px-6 py-4 text-indigo-400 font-extrabold">$${item.commission.toFixed(2)}</td>
            </tr>
        `;
    }).join('');
}

// --- 2. GESTIÓN DE PRODUCTOS (CRUD) ---
function renderAdminProducts() {
    const tbody = document.getElementById('admin-products-table');
    if (products.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">No hay productos registrados.</td></tr>`;
        return;
    }

    tbody.innerHTML = products.map(p => `
        <tr class="hover:bg-slate-800/50 transition-colors">
            <td class="px-6 py-4">
                <img src="${escapeHtml(p.image)}" loading="lazy" class="w-12 h-12 object-cover rounded-xl bg-slate-950 border border-slate-800" onerror="this.src='https://images.unsplash.com/photo-1584438784894-089d6a62b8fa?auto=format&fit=crop&w=600&q=80'">
            </td>
            <td class="px-6 py-4 font-bold text-white">${escapeHtml(p.name)}</td>
            <td class="px-6 py-4"><span class="bg-indigo-500/10 text-indigo-400 font-semibold px-2.5 py-1 rounded-lg text-xs capitalize">${escapeHtml(p.category)}</span></td>
            <td class="px-6 py-4 font-extrabold text-white">$${p.price.toFixed(2)}</td>
            <td class="px-6 py-4 text-right space-x-2">
                <button onclick="openProductModal(${p.id})" class="text-indigo-400 hover:text-indigo-300 font-semibold text-xs bg-indigo-500/10 hover:bg-indigo-500/20 px-3 py-1.5 rounded-lg transition-colors">Editar</button>
                <button onclick="deleteProduct(${p.id})" class="text-rose-400 hover:text-rose-300 font-semibold text-xs bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-colors">Eliminar</button>
            </td>
        </tr>
    `).join('');
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
            document.getElementById('prod-original-price').value = p.originalPrice || '';
            document.getElementById('prod-badge').value = p.badge || '';
            document.getElementById('prod-image').value = p.image;
            document.getElementById('prod-desc').value = p.description;
        }
    } else {
        title.textContent = "Nuevo Producto";
        const form = document.getElementById('product-form');
        if (form) form.reset();
    }

    if (modal) {
        modal.classList.remove('hidden');
        modal.classList.add('flex');
    }
}

function closeProductModal() {
    document.getElementById('product-modal').classList.add('hidden');
    document.getElementById('product-modal').classList.remove('flex');
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

    const payload = { name, category, price, original_price: originalPrice, badge, image, description };

    const { error } = editingProductId
        ? await supabase.from('products').update(payload).eq('id', editingProductId)
        : await supabase.from('products').insert(payload);

    if (error) {
        alert('No se pudo guardar el producto: ' + error.message);
        return;
    }

    await loadCatalog();
    closeProductModal();
    renderAdminProducts();
    showToast("Producto guardado exitosamente");
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
    list.innerHTML = categories.map(cat => `
        <div class="flex items-center justify-between bg-slate-950 p-4 rounded-2xl border border-slate-800">
            <span class="font-bold text-white capitalize">${escapeHtml(cat)}</span>
            <button data-category="${escapeHtml(cat)}" class="delete-category-btn text-rose-400 hover:text-rose-300 text-xs font-bold bg-rose-500/10 hover:bg-rose-500/20 px-3 py-1.5 rounded-lg transition-colors">Eliminar</button>
        </div>
    `).join('');
    list.querySelectorAll('.delete-category-btn').forEach(btn => {
        btn.addEventListener('click', () => deleteCategory(btn.dataset.category));
    });
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
            <td class="px-6 py-4"><span class="bg-emerald-500/10 text-emerald-400 font-bold px-2.5 py-1 rounded-lg text-xs">${a.descuento}% OFF</span></td>
            <td class="px-6 py-4"><span class="bg-indigo-500/10 text-indigo-400 font-bold px-2.5 py-1 rounded-lg text-xs">${a.comision}%</span></td>
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

    if (id !== null && id !== undefined) {
        title.textContent = "Editar Afiliado";
        const a = lastAdminAffiliates.find(x => x.id === id);
        if (a) {
            document.getElementById('aff-code').value = a.codigo;
            document.getElementById('aff-name').value = a.nombre;
            document.getElementById('aff-discount').value = a.descuento;
            document.getElementById('aff-commission').value = a.comision;
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
}

function closeAffiliateModal() {
    document.getElementById('affiliate-modal').classList.add('hidden');
    document.getElementById('affiliate-modal').classList.remove('flex');
}

async function handleSaveAffiliate(e) {
    e.preventDefault();
    const codigo = document.getElementById('aff-code').value.toUpperCase().trim();
    const nombre = document.getElementById('aff-name').value.trim();
    const descuento = parseFloat(document.getElementById('aff-discount').value);
    const comision = parseFloat(document.getElementById('aff-commission').value);
    const pin = document.getElementById('aff-pin').value.trim();

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

function renderPortalDashboard(aff) {
    const initials = aff.nombre.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
    document.getElementById('portal-avatar-initials').textContent = initials;
    document.getElementById('portal-affiliate-name').textContent = aff.nombre;
    document.getElementById('portal-affiliate-code').textContent = aff.codigo;
    document.getElementById('portal-affiliate-discount').textContent = `${aff.descuento}%`;

    // salesHistory ya viene filtrado por el servidor para este afiliado
    // (get_affiliate_sales solo devuelve filas que coinciden con su código
    // Y su PIN correcto).
    const ambassadorSales = salesHistory;
    const totalSales = ambassadorSales.length;
    const totalRevenue = ambassadorSales.reduce((acc, s) => acc + Number(s.monto_venta), 0);
    const totalCommission = ambassadorSales.reduce((acc, s) => acc + Number(s.comision_ganada), 0);

    document.getElementById('portal-stat-sales').textContent = totalSales;
    document.getElementById('portal-stat-revenue').textContent = `$${totalRevenue.toFixed(2)}`;
    document.getElementById('portal-stat-commission').textContent = `$${totalCommission.toFixed(2)}`;

    const referralUrl = `${window.location.origin}${window.location.pathname}?ref=${aff.codigo}`;
    document.getElementById('portal-referral-link').value = referralUrl;

    const tbody = document.getElementById('portal-sales-table');
    if (ambassadorSales.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-10 text-center text-slate-500">Aún no tienes ventas registradas con tu código. ¡Comparte tu enlace!</td></tr>`;
        return;
    }

    tbody.innerHTML = ambassadorSales.map(s => {
        const dateStr = s.fecha ? new Date(s.fecha).toLocaleDateString() : 'Reciente';
        return `
            <tr class="hover:bg-slate-800/50 transition-colors">
                <td class="px-6 py-4">
                    <span class="block font-bold text-white">#${s.id}</span>
                    <span class="block text-[11px] text-slate-400">${dateStr}</span>
                </td>
                <td class="px-6 py-4 text-slate-300 font-medium">${escapeHtml(s.cliente || 'Cliente General')}</td>
                <td class="px-6 py-4 text-white font-bold">$${Number(s.monto_venta).toFixed(2)}</td>
                <td class="px-6 py-4 text-emerald-400 font-extrabold">+$${Number(s.comision_ganada).toFixed(2)}</td>
                <td class="px-6 py-4 text-center">
                    <span class="bg-emerald-500/10 text-emerald-400 font-bold px-3 py-1 rounded-full text-xs">Completado</span>
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
    salesHistory = salesErr ? [] : (sales || []);

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
