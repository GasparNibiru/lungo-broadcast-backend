create or replace function update_admin_payment(
  p_payment_id uuid,
  p_due_date date, p_has_due_date boolean,
  p_expected_amount numeric, p_has_expected_amount boolean,
  p_payment_method text, p_has_payment_method boolean,
  p_notes text, p_has_notes boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment payments%rowtype;
  v_changes jsonb := '{}'::jsonb;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'payment_not_found';
  end if;
  if p_has_expected_amount and (p_expected_amount is null or p_expected_amount < 0) then
    raise exception using errcode = '22023', message = 'invalid_expected_amount';
  end if;
  if p_has_due_date and p_due_date is null then
    raise exception using errcode = '22023', message = 'invalid_due_date';
  end if;

  if p_has_due_date then v_changes := v_changes || jsonb_build_object('due_date', jsonb_build_object('old', v_payment.due_date, 'new', p_due_date)); end if;
  if p_has_expected_amount then v_changes := v_changes || jsonb_build_object('expected_amount', jsonb_build_object('old', v_payment.expected_amount, 'new', p_expected_amount)); end if;
  if p_has_payment_method then v_changes := v_changes || jsonb_build_object('payment_method', jsonb_build_object('old', v_payment.payment_method, 'new', p_payment_method)); end if;
  if p_has_notes then v_changes := v_changes || jsonb_build_object('notes', jsonb_build_object('old', v_payment.notes, 'new', p_notes)); end if;

  update payments set
    due_date = case when p_has_due_date then p_due_date else due_date end,
    expected_amount = case when p_has_expected_amount then p_expected_amount else expected_amount end,
    payment_method = case when p_has_payment_method then p_payment_method else payment_method end,
    notes = case when p_has_notes then p_notes else notes end
  where id = p_payment_id;

  insert into payment_history (payment_id, action, old_status, new_status, amount, notes)
  values (p_payment_id, 'payment_updated', v_payment.status, v_payment.status,
    case when p_has_expected_amount then p_expected_amount else v_payment.expected_amount end,
    v_changes::text);
end;
$$;

create or replace function confirm_admin_payment(
  p_payment_id uuid,
  p_paid_amount numeric,
  p_paid_at timestamptz,
  p_payment_method text, p_has_payment_method boolean,
  p_notes text, p_has_notes boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_payment payments%rowtype;
  v_method text;
  v_notes text;
begin
  select * into v_payment from payments where id = p_payment_id for update;
  if not found then
    raise exception using errcode = 'P0002', message = 'payment_not_found';
  end if;
  if p_paid_amount is null or p_paid_amount < 0 or p_paid_at is null then
    raise exception using errcode = '22023', message = 'invalid_confirmation';
  end if;

  v_method := case when p_has_payment_method then p_payment_method else v_payment.payment_method end;
  v_notes := case when p_has_notes then p_notes else v_payment.notes end;
  if v_payment.status = 'paid'
    and v_payment.paid_amount = p_paid_amount
    and v_payment.paid_at = p_paid_at
    and v_payment.payment_method is not distinct from v_method
    and v_payment.notes is not distinct from v_notes then
    raise exception using errcode = 'P0001', message = 'payment_already_confirmed';
  end if;

  update payments set
    status = 'paid',
    paid_amount = p_paid_amount,
    paid_at = p_paid_at,
    payment_method = v_method,
    notes = v_notes
  where id = p_payment_id;

  insert into payment_history (payment_id, action, old_status, new_status, amount, notes)
  values (p_payment_id, 'payment_confirmed', v_payment.status, 'paid', p_paid_amount, v_notes);
end;
$$;

revoke all on function update_admin_payment(uuid, date, boolean, numeric, boolean, text, boolean, text, boolean) from public;
revoke all on function confirm_admin_payment(uuid, numeric, timestamptz, text, boolean, text, boolean) from public;
grant execute on function update_admin_payment(uuid, date, boolean, numeric, boolean, text, boolean, text, boolean) to service_role;
grant execute on function confirm_admin_payment(uuid, numeric, timestamptz, text, boolean, text, boolean) to service_role;
