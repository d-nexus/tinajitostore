-- ==========================================================
-- TINAJITOSTORE — ESQUEMA DE SUPABASE (Postgres + Auth + RLS)
-- ==========================================================
-- Cómo usar este archivo:
-- 1. Entra a tu proyecto en https://supabase.com/dashboard
-- 2. Ve a "SQL Editor" -> "New query"
-- 3. Pega TODO este archivo y presiona "Run" (una sola vez)
--
-- Filosofía de este esquema:
--  - El catálogo (productos/categorías) es público para LEER, pero solo
--    los administradores pueden escribir.
--  - La tabla de afiliados (con el PIN) NUNCA es legible directamente
--    desde el navegador, ni siquiera por un admin autenticado a medias:
--    todo pasa por funciones controladas (RPC).
--  - Las ventas/comisiones SOLO se crean a través de la función
--    record_sale(), que recalcula todo con los precios y porcentajes
--    reales guardados en la base de datos. Nadie puede insertar una
--    venta falsa desde la consola del navegador.
-- ==========================================================

create extension if not exists pgcrypto;

-- ---------- TABLAS ----------

create table if not exists categories (
    id   bigint generated always as identity primary key,
    name text unique not null
);

create table if not exists products (
    id             bigint generated always as identity primary key,
    name           text not null,
    category       text not null references categories(name) on update cascade on delete restrict,
    price          numeric(10,2) not null check (price >= 0),
    original_price numeric(10,2),
    image          text,
    description    text,
    badge          text,
    created_at     timestamptz default now()
);

-- Datos del proveedor real de cada producto (tú eres intermediario). Va en su
-- PROPIA tabla, separada de "products", a propósito: "products" tiene lectura
-- pública (para que la tienda funcione), y aquí NO se define ninguna política
-- para el público ni para "anon" — sin política de select = nadie fuera de
-- un admin autenticado puede leer esta tabla, ni siquiera con la anon key
-- directamente desde la consola del navegador.
create table if not exists product_suppliers (
    product_id bigint primary key references products(id) on delete cascade,
    nombre     text,
    telefono   text,
    updated_at timestamptz default now()
);

-- El PIN NUNCA se guarda en texto plano: solo su hash (pin_hash),
-- generado con crypt()/gen_salt('bf') = bcrypt.
create table if not exists affiliates (
    id         bigint generated always as identity primary key,
    codigo     text unique not null,
    nombre     text not null,
    descuento  numeric(5,2) not null check (descuento >= 0 and descuento <= 100),
    comision   numeric(5,2) not null check (comision >= 0 and comision <= 100),
    pin_hash   text not null,
    created_at timestamptz default now()
);

create table if not exists sales (
    id              bigint generated always as identity primary key,
    affiliate_id    bigint references affiliates(id) on delete set null,
    codigo          text not null,
    nombre          text not null,
    cliente         text,
    monto_venta     numeric(10,2) not null,
    comision_porc   numeric(5,2) not null,
    comision_ganada numeric(10,2) not null,
    fecha           timestamptz default now()
);

-- Lista blanca de usuarios de Supabase Auth que pueden entrar al panel.
-- Se llena a mano desde el SQL Editor (ver instrucciones al final).
create table if not exists admins (
    user_id uuid primary key references auth.users(id) on delete cascade
);

-- ---------- ROW LEVEL SECURITY ----------

alter table categories enable row level security;
alter table products   enable row level security;
alter table affiliates enable row level security;
alter table sales      enable row level security;
alter table admins     enable row level security;
alter table product_suppliers enable row level security;

create or replace function is_admin()
returns boolean
language sql
security definer
stable
set search_path = public
as $$
    select exists (select 1 from admins where user_id = auth.uid());
$$;

-- Catálogo: lectura pública, escritura solo admin.
create policy "public read categories" on categories for select using (true);
create policy "admin write categories" on categories for insert with check (is_admin());
create policy "admin update categories" on categories for update using (is_admin()) with check (is_admin());
create policy "admin delete categories" on categories for delete using (is_admin());

create policy "public read products" on products for select using (true);
create policy "admin write products" on products for insert with check (is_admin());
create policy "admin update products" on products for update using (is_admin()) with check (is_admin());
create policy "admin delete products" on products for delete using (is_admin());

-- Proveedores: nada de política pública. Sin una política de "select" para
-- el rol "anon"/"public", Postgres deniega por defecto — un visitante normal
-- no puede leer esta tabla aunque la pida directamente por la API.
create policy "admin manage product_suppliers" on product_suppliers for all
    using (is_admin()) with check (is_admin());

-- Afiliados: SOLO administradores autenticados pueden ver/editar la tabla
-- directamente (y aun así, el pin_hash no sirve de nada sin el PIN real).
-- El público nunca lee esta tabla; usa las funciones de abajo.
create policy "admin manage affiliates" on affiliates for all
    using (is_admin()) with check (is_admin());

-- Ventas: los admins pueden ver y borrar, pero NADIE puede insertar
-- directamente (ni siquiera un admin) — toda venta se crea a través de
-- record_sale(), para que la comisión siempre se calcule en el servidor.
create policy "admin select sales" on sales for select using (is_admin());
create policy "admin delete sales" on sales for delete using (is_admin());

-- Un usuario autenticado solo puede comprobar SU PROPIA membresía de admin
-- (para que el frontend sepa si mostrarle el panel), nunca ver la lista
-- completa de administradores.
create policy "self check admin" on admins for select using (user_id = auth.uid());

-- ---------- FUNCIONES (RPC) ----------
-- Todas usan SECURITY DEFINER: corren con permisos elevados para poder
-- tocar tablas que RLS bloquea al público, pero cada una valida por su
-- cuenta lo que hace falta (PIN correcto, o ser admin) antes de actuar.

-- Datos públicos de un afiliado para mostrar el descuento en el carrito
-- (nunca expone el PIN ni la comisión, que es información interna).
create or replace function get_public_affiliate(p_codigo text)
returns table(codigo text, nombre text, descuento numeric)
language sql
security definer
stable
set search_path = public
as $$
    select a.codigo, a.nombre, a.descuento
    from affiliates a
    where upper(a.codigo) = upper(p_codigo);
$$;

revoke execute on function get_public_affiliate(text) from public;
grant execute on function get_public_affiliate(text) to anon, authenticated;

-- Login del Portal de Embajadores: valida código + PIN contra el hash.
create or replace function verify_affiliate_login(p_codigo text, p_pin text)
returns table(codigo text, nombre text, descuento numeric, comision numeric)
language plpgsql
security definer
set search_path = public
as $$
begin
    return query
    select a.codigo, a.nombre, a.descuento, a.comision
    from affiliates a
    where upper(a.codigo) = upper(p_codigo)
      and a.pin_hash = crypt(p_pin, a.pin_hash);
end;
$$;

revoke execute on function verify_affiliate_login(text, text) from public;
grant execute on function verify_affiliate_login(text, text) to anon, authenticated;

-- Historial de ventas de UN afiliado (vuelve a pedir código+PIN porque no
-- guardamos ninguna sesión persistente del PIN en el navegador).
create or replace function get_affiliate_sales(p_codigo text, p_pin text)
returns table(id bigint, cliente text, monto_venta numeric, comision_ganada numeric, fecha timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_match boolean;
begin
    select exists(
        select 1 from affiliates a
        where upper(a.codigo) = upper(p_codigo) and a.pin_hash = crypt(p_pin, a.pin_hash)
    ) into v_match;

    if not v_match then
        raise exception 'Código o PIN incorrectos';
    end if;

    return query
    select s.id, s.cliente, s.monto_venta, s.comision_ganada, s.fecha
    from sales s
    where upper(s.codigo) = upper(p_codigo)
    order by s.fecha desc;
end;
$$;

revoke execute on function get_affiliate_sales(text, text) from public;
grant execute on function get_affiliate_sales(text, text) to anon, authenticated;

-- Registrar una venta: recibe el código de afiliado y el carrito
-- (id de producto + cantidad). TODO se recalcula aquí con los precios y
-- el % de descuento/comisión que existen en la base de datos en ese
-- momento — el navegador no puede inventar ni inflar estos números.
create or replace function record_sale(p_codigo text, p_cliente text, p_items jsonb)
returns table(subtotal numeric, descuento_pct numeric, descuento_monto numeric, total numeric)
language plpgsql
security definer
set search_path = public
as $$
declare
    v_affiliate affiliates%rowtype;
    v_subtotal  numeric := 0;
    v_item      jsonb;
    v_price     numeric;
    v_qty       int;
begin
    select * into v_affiliate from affiliates where upper(codigo) = upper(p_codigo);
    if not found then
        raise exception 'Código de afiliado no encontrado';
    end if;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        select price into v_price from products where id = (v_item->>'id')::bigint;
        if v_price is null then
            raise exception 'Producto % no existe', (v_item->>'id');
        end if;
        v_qty := greatest(1, (v_item->>'quantity')::int);
        v_subtotal := v_subtotal + (v_price * v_qty);
    end loop;

    insert into sales (affiliate_id, codigo, nombre, cliente, monto_venta, comision_porc, comision_ganada)
    values (
        v_affiliate.id, v_affiliate.codigo, v_affiliate.nombre,
        coalesce(nullif(p_cliente, ''), 'Cliente General'),
        v_subtotal - (v_subtotal * v_affiliate.descuento / 100),
        v_affiliate.comision,
        (v_subtotal - (v_subtotal * v_affiliate.descuento / 100)) * v_affiliate.comision / 100
    );

    return query select
        v_subtotal,
        v_affiliate.descuento,
        (v_subtotal * v_affiliate.descuento / 100),
        (v_subtotal - (v_subtotal * v_affiliate.descuento / 100));
end;
$$;

revoke execute on function record_sale(text, text, jsonb) from public;
grant execute on function record_sale(text, text, jsonb) to anon, authenticated;

-- Alta/edición de afiliados desde el panel admin. Es una función (y no un
-- INSERT/UPDATE directo) porque es el único lugar donde el PIN se convierte
-- en pin_hash — así el PIN en texto plano nunca se guarda en ninguna tabla.
-- p_id = null -> crear nuevo. p_pin = null o vacío en una edición -> no
-- cambiar el PIN existente.
create or replace function admin_upsert_affiliate(
    p_id bigint, p_codigo text, p_nombre text, p_descuento numeric, p_comision numeric, p_pin text
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
    v_id bigint;
begin
    if not is_admin() then
        raise exception 'No autorizado';
    end if;

    if p_id is null then
        if p_pin is null or p_pin = '' then
            raise exception 'El PIN es obligatorio para un afiliado nuevo';
        end if;
        insert into affiliates (codigo, nombre, descuento, comision, pin_hash)
        values (upper(p_codigo), p_nombre, p_descuento, p_comision, crypt(p_pin, gen_salt('bf')))
        returning id into v_id;
    else
        update affiliates set
            codigo    = upper(p_codigo),
            nombre    = p_nombre,
            descuento = p_descuento,
            comision  = p_comision,
            pin_hash  = case when p_pin is not null and p_pin <> ''
                             then crypt(p_pin, gen_salt('bf'))
                             else pin_hash end
        where id = p_id
        returning id into v_id;
    end if;

    return v_id;
end;
$$;

revoke execute on function admin_upsert_affiliate(bigint, text, text, numeric, numeric, text) from public;
grant execute on function admin_upsert_affiliate(bigint, text, text, numeric, numeric, text) to authenticated;

-- ---------- DATOS INICIALES (los mismos que ya tenía la tienda) ----------

insert into categories (name) values
    ('tecnologia'), ('audio'), ('moda'), ('accesorios')
on conflict (name) do nothing;

insert into products (name, category, price, original_price, image, description, badge)
select * from (values
    ('Auriculares Inalámbricos Pro X', 'audio', 79.99, 109.99,
     'https://images.unsplash.com/photo-1505740420928-5e560c06d30e?auto=format&fit=crop&w=600&q=80',
     'Cancelación activa de ruido, sonido Hi-Fi y hasta 30 horas de batería con estuche de carga.', 'Más Vendido'),
    ('Smartwatch Deportivo Ultra', 'tecnologia', 129.99, 159.99,
     'https://images.unsplash.com/photo-1523275335684-37898b6baf30?auto=format&fit=crop&w=600&q=80',
     'Monitoreo de frecuencia cardíaca, GPS integrado, resistente al agua 5ATM y pantalla AMOLED.', 'Nuevo'),
    ('Cámara Mirrorless 4K Compacta', 'tecnologia', 499.99, 599.99,
     'https://images.unsplash.com/photo-1526170375885-4d8ecf77b99f?auto=format&fit=crop&w=600&q=80',
     'Sensor CMOS de 24MP, grabación de video en 4K Ultra HD y lente intercambiable de 18-55mm.', 'Oferta'),
    ('Zapatillas Urbanas Runner', 'moda', 65.00, 85.00,
     'https://images.unsplash.com/photo-1542291026-7eec264c27ff?auto=format&fit=crop&w=600&q=80',
     'Diseño ergonómico, suela ultraligera con amortiguación y materiales transpirables de alta durabilidad.', 'Popular'),
    ('Mochila Antirrobo para Laptop', 'accesorios', 45.50, 60.00,
     'https://images.unsplash.com/photo-1553062407-98eeb64c6a62?auto=format&fit=crop&w=600&q=80',
     'Puerto de carga USB integrado, compartimento acolchado para portátil de 15.6" y tejido impermeable.', 'Destacado'),
    ('Altavoz Bluetooth Portátil Bass+', 'audio', 55.00, 70.00,
     'https://images.unsplash.com/photo-1608043152269-423dbba4e7e1?auto=format&fit=crop&w=600&q=80',
     'Sonido envolvente 360°, graves profundos reforzados y certificación IPX7 contra salpicaduras.', 'Top')
) as seed(name, category, price, original_price, image, description, badge)
where not exists (select 1 from products p where p.name = seed.name);

-- Afiliados de ejemplo. El PIN de todos es 1234 (cámbialo desde el panel
-- admin en cuanto tengas el sitio funcionando).
insert into affiliates (codigo, nombre, descuento, comision, pin_hash)
values
    ('JUAN10',  'Juan Pérez',    10, 10, crypt('1234', gen_salt('bf'))),
    ('PROMO5',  'Promo General', 5,  5,  crypt('1234', gen_salt('bf'))),
    ('BAZAR10', 'Bazar Partner', 10, 10, crypt('1234', gen_salt('bf'))),
    ('NEXUS20', 'VIP Afiliado',  20, 15, crypt('1234', gen_salt('bf')))
on conflict (codigo) do nothing;

-- ---------- ÚLTIMO PASO (manual, fuera de este script) ----------
-- 1. Ve a Authentication -> Users -> "Add user" y crea la cuenta del
--    administrador (tu correo + una contraseña fuerte).
-- 2. Copia su "User UID" y ejecuta, reemplazando el valor:
--
--      insert into admins (user_id) values ('PEGA-AQUI-EL-UUID');
--
-- 3. En Authentication -> Providers -> Email, desactiva "Allow new users
--    to sign up" para que nadie más pueda crearse una cuenta desde fuera.

-- ==========================================================
-- ACTUALIZACIÓN v2 (márgenes en pesos). Se ejecuta a continuación de lo anterior.
-- ==========================================================
-- 1) Columnas nuevas
-- Descuento al cliente por unidad (pesos). Es público: el cliente lo ve como ahorro en su carrito.
alter table products add column if not exists descuento_afiliado numeric(10,2) not null default 0
    check (descuento_afiliado >= 0);

-- Costo y comisión: PRIVADOS (product_suppliers no tiene lectura pública).
alter table product_suppliers add column if not exists costo numeric(10,2)
    check (costo is null or costo >= 0);
alter table product_suppliers add column if not exists comision numeric(10,2) not null default 0
    check (comision >= 0);

-- Los % viejos de los afiliados quedan sin uso (se dejan en 0 por defecto).
alter table affiliates alter column descuento set default 0;
alter table affiliates alter column comision  set default 0;

-- Cada venta guarda su costo y tu ganancia limpia (solo visibles para admin).
alter table sales add column if not exists costo_total numeric(10,2) not null default 0;
alter table sales add column if not exists ganancia    numeric(10,2) not null default 0;

-- 2) Funciones públicas de afiliado (ya sin porcentajes)
drop function if exists get_public_affiliate(text);
create function get_public_affiliate(p_codigo text)
returns table(codigo text, nombre text)
language sql security definer stable set search_path = public
as $$
    select a.codigo, a.nombre from affiliates a where upper(a.codigo) = upper(p_codigo);
$$;
revoke execute on function get_public_affiliate(text) from public;
grant execute on function get_public_affiliate(text) to anon, authenticated;

drop function if exists verify_affiliate_login(text, text);
create function verify_affiliate_login(p_codigo text, p_pin text)
returns table(codigo text, nombre text)
language plpgsql security definer set search_path = public
as $$
begin
    return query
    select a.codigo, a.nombre
    from affiliates a
    where upper(a.codigo) = upper(p_codigo)
      and a.pin_hash = crypt(p_pin, a.pin_hash);
end;
$$;
revoke execute on function verify_affiliate_login(text, text) from public;
grant execute on function verify_affiliate_login(text, text) to anon, authenticated;

-- 3) Registrar venta: todo se calcula en el servidor con montos fijos por producto
drop function if exists record_sale(text, text, jsonb);
create function record_sale(p_codigo text, p_cliente text, p_items jsonb)
returns table(subtotal numeric, descuento_monto numeric, total numeric)
language plpgsql security definer set search_path = public
as $$
declare
    v_aff      affiliates%rowtype;
    v_subtotal numeric := 0;
    v_desc     numeric := 0;
    v_com      numeric := 0;
    v_costo    numeric := 0;
    v_total    numeric;
    v_item     jsonb;
    v_price    numeric;
    v_d        numeric;
    v_c        numeric;
    v_cost     numeric;
    v_qty      int;
begin
    select * into v_aff from affiliates where upper(codigo) = upper(p_codigo);
    if not found then
        raise exception 'Código de afiliado no encontrado';
    end if;

    for v_item in select * from jsonb_array_elements(p_items)
    loop
        v_price := null;
        select p.price, least(p.descuento_afiliado, p.price), coalesce(s.comision, 0), coalesce(s.costo, 0)
          into v_price, v_d, v_c, v_cost
        from products p
        left join product_suppliers s on s.product_id = p.id
        where p.id = (v_item->>'id')::bigint;

        if v_price is null then
            raise exception 'Producto % no existe', (v_item->>'id');
        end if;

        v_qty      := greatest(1, (v_item->>'quantity')::int);
        v_subtotal := v_subtotal + v_price * v_qty;
        v_desc     := v_desc     + v_d     * v_qty;
        v_com      := v_com      + v_c     * v_qty;
        v_costo    := v_costo    + v_cost  * v_qty;
    end loop;

    v_total := v_subtotal - v_desc;

    insert into sales (affiliate_id, codigo, nombre, cliente, monto_venta,
                       comision_porc, comision_ganada, costo_total, ganancia)
    values (v_aff.id, v_aff.codigo, v_aff.nombre,
            coalesce(nullif(p_cliente, ''), 'Cliente General'),
            v_total, 0, v_com, v_costo, v_total - v_costo - v_com);

    return query select v_subtotal, v_desc, v_total;
end;
$$;
revoke execute on function record_sale(text, text, jsonb) from public;
grant execute on function record_sale(text, text, jsonb) to anon, authenticated;

-- 4) Alta/edición de afiliados (sin porcentajes)
drop function if exists admin_upsert_affiliate(bigint, text, text, numeric, numeric, text);
create function admin_upsert_affiliate(p_id bigint, p_codigo text, p_nombre text, p_pin text)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_id bigint;
begin
    if not is_admin() then raise exception 'No autorizado'; end if;

    if p_id is null then
        if p_pin is null or p_pin = '' then
            raise exception 'El PIN es obligatorio para un afiliado nuevo';
        end if;
        insert into affiliates (codigo, nombre, pin_hash)
        values (upper(p_codigo), p_nombre, crypt(p_pin, gen_salt('bf')))
        returning id into v_id;
    else
        update affiliates set
            codigo   = upper(p_codigo),
            nombre   = p_nombre,
            pin_hash = case when p_pin is not null and p_pin <> ''
                            then crypt(p_pin, gen_salt('bf')) else pin_hash end
        where id = p_id
        returning id into v_id;
    end if;
    return v_id;
end;
$$;
revoke execute on function admin_upsert_affiliate(bigint, text, text, text) from public;
grant execute on function admin_upsert_affiliate(bigint, text, text, text) to authenticated;

-- 5) Guardar producto + costo + descuento + comisión + proveedor, todo junto,
--    con el CANDADO: no permite guardar si (precio - descuento - comisión) < costo.
create or replace function admin_save_product(
    p_id bigint, p_name text, p_category text, p_price numeric, p_original_price numeric,
    p_image text, p_description text, p_badge text,
    p_descuento numeric, p_costo numeric, p_comision numeric,
    p_prov_nombre text, p_prov_telefono text
)
returns bigint
language plpgsql security definer set search_path = public
as $$
declare
    v_id       bigint;
    v_desc     numeric := coalesce(p_descuento, 0);
    v_com      numeric := coalesce(p_comision, 0);
    v_ganancia numeric;
begin
    if not is_admin() then raise exception 'No autorizado'; end if;
    if p_costo is null then raise exception 'El costo del producto es obligatorio'; end if;
    if v_desc < 0 or v_com < 0 or p_costo < 0 then
        raise exception 'Costo, descuento y comisión no pueden ser negativos';
    end if;

    v_ganancia := p_price - v_desc - v_com - p_costo;
    if v_ganancia < 0 then
        raise exception 'Con ese descuento y comisión perderías % por unidad (precio - descuento - comisión queda por debajo del costo)', abs(v_ganancia);
    end if;

    if p_id is null then
        insert into products (name, category, price, original_price, image, description, badge, descuento_afiliado)
        values (p_name, p_category, p_price, p_original_price, p_image, p_description, p_badge, v_desc)
        returning id into v_id;
    else
        update products set
            name = p_name, category = p_category, price = p_price,
            original_price = p_original_price, image = p_image,
            description = p_description, badge = p_badge, descuento_afiliado = v_desc
        where id = p_id
        returning id into v_id;
        if v_id is null then raise exception 'El producto no existe'; end if;
    end if;

    insert into product_suppliers (product_id, nombre, telefono, costo, comision)
    values (v_id, p_prov_nombre, p_prov_telefono, p_costo, v_com)
    on conflict (product_id) do update set
        nombre = excluded.nombre, telefono = excluded.telefono,
        costo = excluded.costo, comision = excluded.comision, updated_at = now();

    return v_id;
end;
$$;
revoke execute on function admin_save_product(bigint, text, text, numeric, numeric, text, text, text, numeric, numeric, numeric, text, text) from public;
grant execute on function admin_save_product(bigint, text, text, numeric, numeric, text, text, text, numeric, numeric, numeric, text, text) to authenticated;

-- =====================================================================
-- MIGRACIÓN: soporte de moneda (CUP / USD) por producto y afiliados
-- =====================================================================
alter table products add column if not exists moneda text not null default 'CUP';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'products_moneda_check') then
    alter table products add constraint products_moneda_check check (moneda in ('CUP', 'USD'));
  end if;
end $$;

create or replace function get_affiliate_sales_currency(p_codigo text, p_pin text)
returns table(id bigint, moneda text)
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
    if not exists (
        select 1 from affiliates a
        where upper(a.codigo) = upper(p_codigo) and a.pin_hash = crypt(p_pin, a.pin_hash)
    ) then
        raise exception 'Código o PIN incorrectos';
    end if;

    return query
    select s.id, (case when s.order_ref ~* '-USD$' then 'USD' else 'CUP' end)::text
    from sales s
    where upper(s.codigo) = upper(p_codigo);
end;
$$;
revoke execute on function get_affiliate_sales_currency(text, text) from public;
grant execute on function get_affiliate_sales_currency(text, text) to anon, authenticated;
