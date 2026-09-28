-- ==========================================================
-- MIGRACIÓN v2 — Márgenes en pesos (costo, descuento y comisión FIJOS por producto)
-- Corre TODO este archivo UNA vez en Supabase -> SQL Editor -> Run.
-- (Requiere haber corrido antes la migración de proveedores.)
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
