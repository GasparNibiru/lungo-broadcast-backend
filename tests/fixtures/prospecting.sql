-- Local synthetic fixture: relevant types/constraints from live metadata.
-- Never execute this file against an existing database.
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE TYPE public.user_role AS ENUM ('admin_master','supervisor','broker');
CREATE TYPE public.user_status AS ENUM ('active','inactive','suspended','blocked');
CREATE TYPE public.organization_status AS ENUM ('active','inactive','suspended','attention');
CREATE TYPE public.whatsapp_instance_status AS ENUM ('disconnected','connecting','connected','error');
CREATE TABLE public.organizations(id uuid PRIMARY KEY,status public.organization_status NOT NULL DEFAULT 'active');
CREATE TABLE public.users(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 role public.user_role NOT NULL,status public.user_status NOT NULL DEFAULT 'active',UNIQUE(id,organization_id));
CREATE TABLE public.whatsapp_instances(id uuid PRIMARY KEY,organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 user_id uuid,instance_name text NOT NULL UNIQUE,status public.whatsapp_instance_status NOT NULL DEFAULT 'connected',
 FOREIGN KEY(user_id,organization_id) REFERENCES public.users(id,organization_id) ON DELETE SET NULL (user_id));

-- CANDIDATE: NOT EXECUTED REMOTELY. Operational staging hgqtanlzajogxrfbchrl only.
-- Audited PostgreSQL 17.6. Execution requires separate authorization.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- Deliberately use CREATE, not IF NOT EXISTS: conflicting existing objects must fail.
-- No extension installation; core gen_random_uuid() required (verify server version).
CREATE TABLE public.prospecting_company_snapshots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cnpj text NOT NULL CHECK (cnpj ~ '^[0-9]{14}$'),
  trade_name text, legal_name text NOT NULL CHECK (length(legal_name) BETWEEN 1 AND 512),
  mobile_1 text NOT NULL CHECK (mobile_1 ~ '^[0-9]{10,15}$'),
  mobile_2 text CHECK (mobile_2 IS NULL OR mobile_2 ~ '^[0-9]{10,15}$'),
  email text CHECK (email IS NULL OR length(email) <= 320),
  category text NOT NULL CHECK (length(category) <= 128),
  cnae text NOT NULL CHECK (cnae ~ '^[0-9]{7}$'),
  opened_year integer NOT NULL CHECK (opened_year BETWEEN 1900 AND 9999),
  company_size text NOT NULL CHECK (length(company_size) <= 64),
  city text NOT NULL CHECK (length(city) <= 128),
  state text NOT NULL CHECK (state ~ '^[A-Z]{2}$'),
  source_version text NOT NULL CHECK (source_version ~ '^[0-9]{4}-[0-9]{2}$'),
  source_project_ref text NOT NULL DEFAULT 'fmktrtyahaudefcymrvm'
    CHECK (source_project_ref = 'fmktrtyahaudefcymrvm'),
  source_table text NOT NULL DEFAULT 'companies_v2' CHECK (source_table = 'companies_v2'),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (cnpj, source_version, content_hash), UNIQUE (id, cnpj)
);

CREATE TABLE public.prospecting_wallets (
  user_id uuid PRIMARY KEY REFERENCES public.users(id) ON DELETE RESTRICT,
  free_balance bigint NOT NULL DEFAULT 0 CHECK (free_balance >= 0),
  extra_balance bigint NOT NULL DEFAULT 0 CHECK (extra_balance >= 0),
  cycle_start date NOT NULL CHECK (extract(day FROM cycle_start) = 5),
  cycle_allowance integer NOT NULL CHECK (cycle_allowance IN (20,100)),
  version bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE public.prospecting_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_kind text NOT NULL CHECK (actor_kind IN ('user','admin','system')),
  actor_reference text NOT NULL CHECK (length(actor_reference) BETWEEN 1 AND 160),
  actor_user_id uuid REFERENCES public.users(id) ON DELETE RESTRICT,
  operation_type text NOT NULL CHECK (operation_type IN ('purchase','assignment','credit','renewal')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  request_fingerprint jsonb NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_kind, actor_reference, operation_type, idempotency_key)
);

CREATE TABLE public.prospecting_user_companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  organization_id_at_acquisition uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  cnpj text NOT NULL,
  snapshot_id uuid NOT NULL,
  acquired_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  acquisition_origin text NOT NULL CHECK (acquisition_origin IN ('purchase','supervisor_assignment')),
  operation_id uuid NOT NULL REFERENCES public.prospecting_operations(id) ON DELETE RESTRICT,
  token_cost smallint NOT NULL,
  token_bucket text,
  service_status text NOT NULL DEFAULT 'new'
    CHECK (service_status IN ('new','contacted','follow_up','interested','not_interested','converted')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  last_contact_at timestamptz, next_follow_up_at timestamptz,
  version bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (user_id, cnpj), UNIQUE (id, user_id), UNIQUE (id, cnpj),
  FOREIGN KEY (snapshot_id, cnpj) REFERENCES public.prospecting_company_snapshots(id, cnpj) ON DELETE RESTRICT,
  CHECK ((acquisition_origin = 'purchase' AND token_cost = 1
          AND token_bucket IS NOT NULL AND token_bucket IN ('free','extra'))
      OR (acquisition_origin = 'supervisor_assignment' AND token_cost = 0 AND token_bucket IS NULL))
);

CREATE TABLE public.prospecting_token_movements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES public.prospecting_wallets(user_id) ON DELETE RESTRICT,
  operation_id uuid NOT NULL REFERENCES public.prospecting_operations(id) ON DELETE RESTRICT,
  movement_type text NOT NULL CHECK (movement_type IN ('renewal','cycle_expiry','extra_credit','purchase')),
  bucket text NOT NULL CHECK (bucket IN ('free','extra')),
  delta bigint NOT NULL CHECK (delta <> 0),
  balance_after bigint NOT NULL CHECK (balance_after >= 0),
  user_company_id uuid,
  cycle_start date,
  reason text NOT NULL CHECK (length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_company_id, user_id) REFERENCES public.prospecting_user_companies(id, user_id) ON DELETE RESTRICT,
  CHECK ((movement_type = 'purchase' AND delta = -1 AND user_company_id IS NOT NULL)
      OR (movement_type = 'renewal' AND bucket = 'free' AND delta IN (20,100) AND user_company_id IS NULL AND cycle_start IS NOT NULL)
      OR (movement_type = 'cycle_expiry' AND bucket = 'free' AND delta < 0 AND user_company_id IS NULL AND cycle_start IS NOT NULL)
      OR (movement_type = 'extra_credit' AND bucket = 'extra' AND delta > 0 AND user_company_id IS NULL))
);
CREATE UNIQUE INDEX prospecting_purchase_once ON public.prospecting_token_movements(user_company_id)
  WHERE movement_type = 'purchase';
CREATE UNIQUE INDEX prospecting_cycle_movement_once ON public.prospecting_token_movements(user_id, cycle_start, movement_type)
  WHERE movement_type IN ('renewal','cycle_expiry');

CREATE TABLE public.prospecting_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL REFERENCES public.prospecting_operations(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  supervisor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  broker_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  cnpj text NOT NULL,
  source_user_company_id uuid NOT NULL,
  target_user_company_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (supervisor_user_id <> broker_user_id),
  FOREIGN KEY (source_user_company_id, supervisor_user_id) REFERENCES public.prospecting_user_companies(id, user_id),
  FOREIGN KEY (target_user_company_id, broker_user_id) REFERENCES public.prospecting_user_companies(id, user_id),
  FOREIGN KEY (source_user_company_id, cnpj) REFERENCES public.prospecting_user_companies(id, cnpj),
  FOREIGN KEY (target_user_company_id, cnpj) REFERENCES public.prospecting_user_companies(id, cnpj),
  UNIQUE (source_user_company_id, broker_user_id)
);

CREATE TABLE public.prospecting_interactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_company_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  status text NOT NULL CHECK (status IN ('new','contacted','follow_up','interested','not_interested','converted')),
  notes text NOT NULL DEFAULT '' CHECK (length(notes) <= 10000),
  contact_at timestamptz, next_follow_up_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (user_company_id, actor_user_id) REFERENCES public.prospecting_user_companies(id, user_id),
  UNIQUE (actor_user_id, idempotency_key)
);

CREATE TABLE public.prospecting_message_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_company_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
  -- Legacy resolver required. Never store API keys or login tokens here.
  instance_reference text NOT NULL CHECK (length(instance_reference) BETWEEN 1 AND 200),
  recipient_phone text NOT NULL CHECK (recipient_phone ~ '^[0-9]{10,15}$'),
  message text NOT NULL CHECK (length(message) BETWEEN 1 AND 4096),
  scheduled_at timestamptz NOT NULL, timezone text NOT NULL DEFAULT 'America/Sao_Paulo',
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','sent','failed','unknown','cancelled')),
  idempotency_key text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 160),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz, locked_until timestamptz, worker_id uuid,
  provider_message_id text, last_error_code text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), sent_at timestamptz,
  FOREIGN KEY (user_company_id, owner_user_id) REFERENCES public.prospecting_user_companies(id, user_id),
  UNIQUE (owner_user_id, idempotency_key)
);

CREATE TABLE public.prospecting_lead_exports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_company_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  operation_key uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','exported','failed','unknown')),
  target_lead_id text UNIQUE,
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error_code text, locked_until timestamptz, worker_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), exported_at timestamptz,
  FOREIGN KEY (user_company_id, owner_user_id) REFERENCES public.prospecting_user_companies(id, user_id),
  CHECK ((status = 'exported') = (exported_at IS NOT NULL)),
  CHECK (status <> 'exported' OR target_lead_id IS NOT NULL)
);

CREATE INDEX prospecting_owned_page ON public.prospecting_user_companies(user_id, acquired_at DESC, id);
CREATE INDEX prospecting_follow_up ON public.prospecting_user_companies(user_id, next_follow_up_at, id)
  WHERE next_follow_up_at IS NOT NULL;
CREATE INDEX prospecting_owned_snapshot ON public.prospecting_user_companies(snapshot_id, cnpj);
CREATE INDEX prospecting_owned_org ON public.prospecting_user_companies(organization_id_at_acquisition);
CREATE INDEX prospecting_owned_operation ON public.prospecting_user_companies(operation_id);
CREATE INDEX prospecting_movement_page ON public.prospecting_token_movements(user_id, created_at DESC, id);
CREATE INDEX prospecting_movement_operation ON public.prospecting_token_movements(operation_id);
CREATE INDEX prospecting_operation_actor ON public.prospecting_operations(actor_user_id);
CREATE INDEX prospecting_assignment_supervisor ON public.prospecting_assignments(supervisor_user_id, assigned_at DESC);
CREATE INDEX prospecting_assignment_broker ON public.prospecting_assignments(broker_user_id, assigned_at DESC);
CREATE INDEX prospecting_assignment_org ON public.prospecting_assignments(organization_id);
CREATE INDEX prospecting_assignment_operation ON public.prospecting_assignments(operation_id);
CREATE INDEX prospecting_assignment_target ON public.prospecting_assignments(target_user_company_id);
CREATE INDEX prospecting_interaction_history ON public.prospecting_interactions(user_company_id, created_at DESC, id);
CREATE INDEX prospecting_schedule_company ON public.prospecting_message_schedules(user_company_id);
CREATE INDEX prospecting_schedule_org ON public.prospecting_message_schedules(organization_id);
CREATE INDEX prospecting_schedule_due ON public.prospecting_message_schedules(scheduled_at, id) WHERE status = 'pending';
CREATE INDEX prospecting_export_owner ON public.prospecting_lead_exports(owner_user_id);
CREATE INDEX prospecting_export_due ON public.prospecting_lead_exports(created_at, id) WHERE status = 'pending';

-- Core helper: lock identity first, then organization, then wallets. Never trust client user IDs.
-- RPC callers are server-only and must derive actor IDs from requireAccess/requireAdmin.
CREATE FUNCTION public.prospecting_lock_user(p_user uuid)
RETURNS public.users LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u public.users; org_status text;
BEGIN
  SELECT * INTO STRICT u FROM public.users WHERE id = p_user FOR SHARE;
  SELECT status::text INTO STRICT org_status FROM public.organizations WHERE id = u.organization_id FOR SHARE;
  IF u.status::text <> 'active' OR u.role::text NOT IN ('broker','supervisor') OR org_status <> 'active' THEN
    RAISE EXCEPTION 'prospecting_access_denied' USING ERRCODE = '42501';
  END IF;
  RETURN u;
END $$;

CREATE FUNCTION public.prospecting_cycle(p_at timestamptz)
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT (date_trunc('month', (p_at AT TIME ZONE 'America/Sao_Paulo') - interval '4 days') + interval '4 days')::date
$$;

-- Internal; called only by server RPCs. Assignment does NOT initialize a free wallet.
CREATE FUNCTION public.prospecting_refresh_wallet(p_user uuid)
RETURNS public.prospecting_wallets LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u public.users; w public.prospecting_wallets; cycle_date date;
        allowance integer; op uuid;
BEGIN
  u := public.prospecting_lock_user(p_user);
  cycle_date := public.prospecting_cycle(clock_timestamp());
  allowance := CASE u.role::text WHEN 'supervisor' THEN 100 ELSE 20 END;
  INSERT INTO public.prospecting_wallets(user_id, cycle_start, cycle_allowance)
    VALUES(p_user, cycle_date, allowance) ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO STRICT w FROM public.prospecting_wallets WHERE user_id = p_user FOR UPDATE;
  -- Compute AFTER waiting for the wallet lock (purchase near midnight).
  cycle_date := public.prospecting_cycle(clock_timestamp());
  IF w.cycle_start > cycle_date THEN RAISE EXCEPTION 'prospecting_clock_or_cycle_invalid'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.prospecting_token_movements
                WHERE user_id=p_user AND cycle_start=cycle_date AND movement_type='renewal') THEN
    INSERT INTO public.prospecting_operations(actor_kind,actor_reference,operation_type,idempotency_key,request_fingerprint)
      VALUES('system',p_user::text,'renewal',cycle_date::text,jsonb_build_object('cycle',cycle_date)) RETURNING id INTO op;
    IF w.free_balance > 0 THEN
      INSERT INTO public.prospecting_token_movements(user_id,operation_id,movement_type,bucket,delta,balance_after,cycle_start,reason)
        VALUES(p_user,op,'cycle_expiry','free',-w.free_balance,0,cycle_date,'Descarte da franquia anterior');
    END IF;
    UPDATE public.prospecting_wallets SET free_balance=allowance,cycle_start=cycle_date,
      cycle_allowance=allowance,version=version+1,updated_at=clock_timestamp()
      WHERE user_id=p_user RETURNING * INTO w;
    INSERT INTO public.prospecting_token_movements(user_id,operation_id,movement_type,bucket,delta,balance_after,cycle_start,reason)
      VALUES(p_user,op,'renewal','free',allowance,allowance,cycle_date,'Renovação mensal');
    UPDATE public.prospecting_operations SET result=jsonb_build_object('cycle',cycle_date,'allowance',allowance) WHERE id=op;
  END IF;
  RETURN w;
END $$;

CREATE FUNCTION public.prospecting_get_wallet(p_user uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w public.prospecting_wallets;
BEGIN
  w := public.prospecting_refresh_wallet(p_user);
  RETURN jsonb_build_object('free',w.free_balance,'extra',w.extra_balance,'total',w.free_balance+w.extra_balance,
    'nextRenewal',(w.cycle_start + interval '1 month')::date,'version',w.version);
END $$;

-- Input is trusted server-resolved snapshots, NEVER payload passed through from the browser.
-- Hash is computed in PostgreSQL over the canonical 12-field JSON, not supplied by client.
CREATE FUNCTION public.prospecting_acquire(p_user uuid, p_key text, p_companies jsonb, p_source_version text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE u public.users; w public.prospecting_wallets; old_op public.prospecting_operations;
        fingerprint jsonb; item jsonb; fields jsonb; hash text; snap uuid; owned uuid;
        op uuid; bucket_name text; remaining integer; result_value jsonb; ids uuid[] := '{}';
BEGIN
  IF p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160
     OR p_companies IS NULL OR jsonb_typeof(p_companies) <> 'array' THEN RAISE EXCEPTION 'invalid_purchase'; END IF;
  IF jsonb_array_length(p_companies) NOT BETWEEN 1 AND 100 OR p_source_version IS NULL
     OR p_source_version !~ '^[0-9]{4}-[0-9]{2}$' THEN RAISE EXCEPTION 'invalid_purchase'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_companies) x
            WHERE jsonb_typeof(x) <> 'object' OR x->>'cnpj' IS NULL OR x->>'cnpj' !~ '^[0-9]{14}$') THEN
    RAISE EXCEPTION 'invalid_company';
  END IF;
  IF (SELECT count(DISTINCT x->>'cnpj') FROM jsonb_array_elements(p_companies) x) <> jsonb_array_length(p_companies) THEN
    RAISE EXCEPTION 'duplicate_company_in_request';
  END IF;
  u := public.prospecting_lock_user(p_user);
  -- Common per-user lock also used by assignments, including users without wallets.
  PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||p_user::text,0));
  SELECT jsonb_build_object('cnpjs',jsonb_agg(x->>'cnpj' ORDER BY x->>'cnpj'),'version',p_source_version)
    INTO fingerprint FROM jsonb_array_elements(p_companies) x;
  SELECT * INTO old_op FROM public.prospecting_operations
    WHERE actor_kind='user' AND actor_reference=p_user::text AND operation_type='purchase' AND idempotency_key=p_key;
  IF FOUND THEN
    IF old_op.request_fingerprint <> fingerprint THEN RAISE EXCEPTION 'idempotency_key_reused'; END IF;
    RETURN old_op.result;
  END IF;
  w := public.prospecting_refresh_wallet(p_user);
  SELECT count(*) INTO remaining FROM jsonb_array_elements(p_companies) x
    WHERE NOT EXISTS(SELECT 1 FROM public.prospecting_user_companies c WHERE c.user_id=p_user AND c.cnpj=x->>'cnpj');
  IF w.free_balance+w.extra_balance < remaining THEN RAISE EXCEPTION 'insufficient_tokens'; END IF;
  INSERT INTO public.prospecting_operations(actor_kind,actor_reference,actor_user_id,operation_type,idempotency_key,request_fingerprint)
    VALUES('user',p_user::text,p_user,'purchase',p_key,fingerprint) RETURNING id INTO op;
  FOR item IN SELECT x FROM jsonb_array_elements(p_companies) x ORDER BY x->>'cnpj' LOOP
    SELECT id INTO owned FROM public.prospecting_user_companies WHERE user_id=p_user AND cnpj=item->>'cnpj';
    IF FOUND THEN CONTINUE; END IF;
    fields := jsonb_build_object('cnpj',item->>'cnpj','trade_name',nullif(btrim(item->>'trade_name'),''),
      'legal_name',btrim(item->>'legal_name'),'mobile_1',item->>'mobile_1','mobile_2',nullif(item->>'mobile_2',''),
      'email',nullif(btrim(item->>'email'),''),'category',btrim(item->>'category'),'cnae',item->>'cnae',
      'opened_year',(item->>'opened_year')::integer,'company_size',btrim(item->>'company_size'),
      'city',btrim(item->>'city'),'state',upper(item->>'state'));
    hash := encode(sha256(convert_to(fields::text,'UTF8')),'hex');
    INSERT INTO public.prospecting_company_snapshots(cnpj,trade_name,legal_name,mobile_1,mobile_2,email,
        category,cnae,opened_year,company_size,city,state,source_version,content_hash)
      VALUES(fields->>'cnpj',fields->>'trade_name',fields->>'legal_name',fields->>'mobile_1',fields->>'mobile_2',fields->>'email',
        fields->>'category',fields->>'cnae',(fields->>'opened_year')::integer,fields->>'company_size',fields->>'city',fields->>'state',p_source_version,hash)
      ON CONFLICT (cnpj,source_version,content_hash) DO NOTHING;
    SELECT id INTO STRICT snap FROM public.prospecting_company_snapshots
      WHERE cnpj=fields->>'cnpj' AND source_version=p_source_version AND content_hash=hash;
    bucket_name := CASE WHEN w.free_balance>0 THEN 'free' ELSE 'extra' END;
    INSERT INTO public.prospecting_user_companies(user_id,organization_id_at_acquisition,cnpj,snapshot_id,
        acquisition_origin,operation_id,token_cost,token_bucket)
      VALUES(p_user,u.organization_id,fields->>'cnpj',snap,'purchase',op,1,bucket_name) RETURNING id INTO owned;
    IF bucket_name='free' THEN w.free_balance:=w.free_balance-1; ELSE w.extra_balance:=w.extra_balance-1; END IF;
    INSERT INTO public.prospecting_token_movements(user_id,operation_id,movement_type,bucket,delta,balance_after,user_company_id,reason)
      VALUES(p_user,op,'purchase',bucket_name,-1,CASE WHEN bucket_name='free' THEN w.free_balance ELSE w.extra_balance END,owned,'Empresa adquirida');
    ids := array_append(ids,owned);
  END LOOP;
  UPDATE public.prospecting_wallets SET free_balance=w.free_balance,extra_balance=w.extra_balance,
    version=version+1,updated_at=clock_timestamp() WHERE user_id=p_user;
  result_value := jsonb_build_object('operationId',op,'acquiredIds',ids,'charged',cardinality(ids),
    'alreadyOwned',jsonb_array_length(p_companies)-cardinality(ids),'free',w.free_balance,'extra',w.extra_balance);
  UPDATE public.prospecting_operations SET result=result_value WHERE id=op;
  RETURN result_value;
END $$;

-- Admin authentication stays in require-admin. The server supplies a stable audit actor
-- (never the admin key). Current shared admin key cannot prove individual human identity.
CREATE FUNCTION public.prospecting_credit_extra(p_user uuid,p_key text,p_amount bigint,p_admin_reference text,p_reason text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE w public.prospecting_wallets; op public.prospecting_operations; fp jsonb; result_value jsonb;
BEGIN
  IF p_amount IS NULL OR p_amount<=0 OR p_amount>1000000 OR p_admin_reference IS NULL OR btrim(p_admin_reference)=''
     OR p_key IS NULL OR length(p_key) NOT BETWEEN 1 AND 160 OR p_reason IS NULL OR length(p_reason) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'invalid_credit';
  END IF;
  PERFORM public.prospecting_lock_user(p_user);
  PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||p_user::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('prospecting-admin:'||p_admin_reference||':'||p_key,0));
  fp:=jsonb_build_object('user',p_user,'amount',p_amount,'reason',p_reason);
  SELECT * INTO op FROM public.prospecting_operations WHERE actor_kind='admin' AND actor_reference=p_admin_reference
    AND operation_type='credit' AND idempotency_key=p_key;
  IF FOUND THEN
    IF op.request_fingerprint<>fp THEN RAISE EXCEPTION 'idempotency_key_reused'; END IF;
    RETURN op.result;
  END IF;
  -- An administrative credit alone must NOT count as first user access or initialize a cycle.
  -- A wallet can exist with zero free balance until get_wallet/acquire applies the first grant.
  INSERT INTO public.prospecting_wallets(user_id,cycle_start,cycle_allowance)
    SELECT id,public.prospecting_cycle(clock_timestamp()),CASE role::text WHEN 'supervisor' THEN 100 ELSE 20 END
    FROM public.users WHERE id=p_user ON CONFLICT (user_id) DO NOTHING;
  SELECT * INTO STRICT w FROM public.prospecting_wallets WHERE user_id=p_user FOR UPDATE;
  INSERT INTO public.prospecting_operations(actor_kind,actor_reference,operation_type,idempotency_key,request_fingerprint)
    VALUES('admin',p_admin_reference,'credit',p_key,fp) RETURNING * INTO op;
  UPDATE public.prospecting_wallets SET extra_balance=extra_balance+p_amount,version=version+1,updated_at=clock_timestamp()
    WHERE user_id=p_user RETURNING * INTO w;
  INSERT INTO public.prospecting_token_movements(user_id,operation_id,movement_type,bucket,delta,balance_after,reason)
    VALUES(p_user,op.id,'extra_credit','extra',p_amount,w.extra_balance,p_reason);
  result_value:=jsonb_build_object('operationId',op.id,'extra',w.extra_balance,'free',w.free_balance);
  UPDATE public.prospecting_operations SET result=result_value WHERE id=op.id;
  RETURN result_value;
END $$;

CREATE FUNCTION public.prospecting_assign(p_supervisor uuid,p_broker uuid,p_key text,p_company_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE supervisor public.users; broker public.users; lock_id uuid; source public.prospecting_user_companies;
        fp jsonb; op public.prospecting_operations; owned uuid; assigned integer:=0; skipped integer:=0; rv jsonb;
BEGIN
  IF p_supervisor IS NULL OR p_broker IS NULL OR p_supervisor=p_broker OR p_key IS NULL
    OR length(p_key) NOT BETWEEN 1 AND 160 OR p_company_ids IS NULL OR cardinality(p_company_ids) NOT BETWEEN 1 AND 100
    OR array_position(p_company_ids,NULL) IS NOT NULL THEN RAISE EXCEPTION 'invalid_assignment'; END IF;
  IF (SELECT count(DISTINCT x) FROM unnest(p_company_ids) x)<>cardinality(p_company_ids) THEN RAISE EXCEPTION 'duplicate_selection'; END IF;
  FOR lock_id IN SELECT x FROM unnest(ARRAY[p_supervisor,p_broker]) x ORDER BY x LOOP
    PERFORM public.prospecting_lock_user(lock_id);
  END LOOP;
  FOR lock_id IN SELECT x FROM unnest(ARRAY[p_supervisor,p_broker]) x ORDER BY x LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||lock_id::text,0));
  END LOOP;
  SELECT * INTO STRICT supervisor FROM public.users WHERE id=p_supervisor;
  SELECT * INTO STRICT broker FROM public.users WHERE id=p_broker;
  IF supervisor.role::text<>'supervisor' OR broker.role::text<>'broker' OR supervisor.organization_id<>broker.organization_id THEN
    RAISE EXCEPTION 'assignment_access_denied' USING ERRCODE='42501';
  END IF;
  SELECT jsonb_build_object('broker',p_broker,'ids',jsonb_agg(x ORDER BY x)) INTO fp FROM unnest(p_company_ids) x;
  SELECT * INTO op FROM public.prospecting_operations WHERE actor_kind='user' AND actor_reference=p_supervisor::text
    AND operation_type='assignment' AND idempotency_key=p_key;
  IF FOUND THEN
    IF op.request_fingerprint<>fp THEN RAISE EXCEPTION 'idempotency_key_reused'; END IF;
    RETURN op.result;
  END IF;
  IF (SELECT count(*) FROM public.prospecting_user_companies WHERE id=ANY(p_company_ids) AND user_id=p_supervisor)<>cardinality(p_company_ids) THEN
    RAISE EXCEPTION 'company_not_owned';
  END IF;
  INSERT INTO public.prospecting_operations(actor_kind,actor_reference,actor_user_id,operation_type,idempotency_key,request_fingerprint)
    VALUES('user',p_supervisor::text,p_supervisor,'assignment',p_key,fp) RETURNING * INTO op;
  FOR source IN SELECT * FROM public.prospecting_user_companies WHERE id=ANY(p_company_ids) ORDER BY cnpj LOOP
    SELECT id INTO owned FROM public.prospecting_user_companies WHERE user_id=p_broker AND cnpj=source.cnpj;
    IF FOUND THEN
      INSERT INTO public.prospecting_assignments(operation_id,organization_id,supervisor_user_id,broker_user_id,cnpj,source_user_company_id,target_user_company_id)
        VALUES(op.id,supervisor.organization_id,p_supervisor,p_broker,source.cnpj,source.id,owned)
        ON CONFLICT (source_user_company_id,broker_user_id) DO NOTHING;
      skipped:=skipped+1; CONTINUE;
    END IF;
    INSERT INTO public.prospecting_user_companies(user_id,organization_id_at_acquisition,cnpj,snapshot_id,acquisition_origin,operation_id,token_cost)
      VALUES(p_broker,broker.organization_id,source.cnpj,source.snapshot_id,'supervisor_assignment',op.id,0) RETURNING id INTO owned;
    INSERT INTO public.prospecting_assignments(operation_id,organization_id,supervisor_user_id,broker_user_id,cnpj,source_user_company_id,target_user_company_id)
      VALUES(op.id,supervisor.organization_id,p_supervisor,p_broker,source.cnpj,source.id,owned);
    assigned:=assigned+1;
  END LOOP;
  rv:=jsonb_build_object('operationId',op.id,'assigned',assigned,'alreadyOwned',skipped,'charged',0);
  UPDATE public.prospecting_operations SET result=rv WHERE id=op.id;
  RETURN rv;
END $$;

-- Deferred check protects the purchase <-> movement and assignment <-> grant invariant.
CREATE FUNCTION public.prospecting_check_acquisition()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.prospecting_user_companies;
BEGIN
  SELECT * INTO STRICT c FROM public.prospecting_user_companies WHERE id=NEW.id;
  IF c.acquisition_origin='purchase' THEN
    IF NOT EXISTS(SELECT 1 FROM public.prospecting_token_movements m WHERE m.user_company_id=c.id
      AND m.movement_type='purchase' AND m.user_id=c.user_id AND m.operation_id=c.operation_id AND m.bucket=c.token_bucket AND m.delta=-1) THEN
      RAISE EXCEPTION 'purchase_requires_matching_debit';
    END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.prospecting_assignments a WHERE a.target_user_company_id=c.id AND a.operation_id=c.operation_id AND a.broker_user_id=c.user_id AND a.organization_id=c.organization_id_at_acquisition) THEN
      RAISE EXCEPTION 'received_company_requires_assignment';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER prospecting_acquisition_consistency AFTER INSERT ON public.prospecting_user_companies
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.prospecting_check_acquisition();

-- No direct mutation of audit/snapshot/acquisition identity, even via service_role.
CREATE FUNCTION public.prospecting_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION 'prospecting_immutable_record'; END $$;
CREATE TRIGGER prospecting_snapshot_immutable BEFORE UPDATE OR DELETE ON public.prospecting_company_snapshots
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_immutable();
CREATE TRIGGER prospecting_movement_immutable BEFORE UPDATE OR DELETE ON public.prospecting_token_movements
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_immutable();
CREATE TRIGGER prospecting_assignment_immutable BEFORE UPDATE OR DELETE ON public.prospecting_assignments
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_immutable();
CREATE TRIGGER prospecting_interaction_immutable BEFORE UPDATE OR DELETE ON public.prospecting_interactions
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_immutable();

CREATE FUNCTION public.prospecting_owned_identity_immutable()
RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'permanent_acquisition'; END IF;
  IF (to_jsonb(NEW)-ARRAY['service_status','notes','last_contact_at','next_follow_up_at','version','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['service_status','notes','last_contact_at','next_follow_up_at','version','updated_at']) THEN
    RAISE EXCEPTION 'acquisition_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER prospecting_owned_identity BEFORE UPDATE OR DELETE ON public.prospecting_user_companies
  FOR EACH ROW EXECUTE FUNCTION public.prospecting_owned_identity_immutable();

-- Explicit allowlist: do not change privileges on unrelated CRM tables/functions.
DO $$ DECLARE t text; f record; BEGIN
  FOREACH t IN ARRAY ARRAY['prospecting_company_snapshots','prospecting_wallets','prospecting_operations',
    'prospecting_user_companies','prospecting_token_movements','prospecting_assignments',
    'prospecting_interactions','prospecting_message_schedules','prospecting_lead_exports'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',t);
    EXECUTE format('GRANT SELECT ON TABLE public.%I TO service_role',t);
  END LOOP;
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('prospecting_lock_user','prospecting_cycle','prospecting_refresh_wallet',
      'prospecting_get_wallet','prospecting_acquire','prospecting_credit_extra','prospecting_assign',
      'prospecting_check_acquisition','prospecting_immutable','prospecting_owned_identity_immutable') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role',f.signature);
  END LOOP;
END $$;
GRANT EXECUTE ON FUNCTION public.prospecting_get_wallet(uuid), public.prospecting_acquire(uuid,text,jsonb,text),
  public.prospecting_credit_extra(uuid,text,bigint,text,text), public.prospecting_assign(uuid,uuid,text,uuid[]) TO service_role;

-- Additional schema and controlled RPCs. Included before COMMIT by build.py.
ALTER TABLE public.prospecting_operations ADD CONSTRAINT prospecting_actor_consistency CHECK (
 (actor_kind='user' AND actor_user_id IS NOT NULL AND actor_reference=actor_user_id::text AND operation_type IN ('purchase','assignment'))
 OR (actor_kind='admin' AND actor_user_id IS NULL AND operation_type='credit')
 OR (actor_kind='system' AND actor_user_id IS NULL AND operation_type='renewal'));

CREATE FUNCTION public.prospecting_check_movement()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.movement_type='purchase' AND NOT EXISTS (
   SELECT 1 FROM public.prospecting_user_companies c JOIN public.prospecting_operations o ON o.id=c.operation_id
   WHERE c.id=NEW.user_company_id AND c.user_id=NEW.user_id AND c.acquisition_origin='purchase'
     AND c.operation_id=NEW.operation_id AND c.token_bucket=NEW.bucket AND c.token_cost=1 AND NEW.delta=-1
     AND o.operation_type='purchase' AND o.actor_user_id=c.user_id
 ) THEN RAISE EXCEPTION 'debit_requires_matching_purchase'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER prospecting_debit_consistency AFTER INSERT ON public.prospecting_token_movements
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.prospecting_check_movement();

CREATE FUNCTION public.prospecting_check_assignment()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM public.prospecting_operations o WHERE o.id=NEW.operation_id
   AND o.operation_type='assignment' AND o.actor_user_id=NEW.supervisor_user_id) THEN
   RAISE EXCEPTION 'assignment_requires_matching_operation'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER prospecting_assignment_consistency AFTER INSERT ON public.prospecting_assignments
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.prospecting_check_assignment();

-- All RPC user IDs are derived by server middleware, never browser parameters.
CREATE FUNCTION public.prospecting_record_interaction(p_user uuid,p_company uuid,p_key text,p_status text,
 p_notes text,p_contact timestamptz,p_follow_up timestamptz,p_expected_version bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.prospecting_user_companies; previous public.prospecting_interactions; entry uuid;
BEGIN
 PERFORM public.prospecting_lock_user(p_user);
 PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||p_user::text,0));
 SELECT * INTO previous FROM public.prospecting_interactions WHERE actor_user_id=p_user AND idempotency_key=p_key;
 IF FOUND THEN
   IF ROW(previous.user_company_id,previous.status,previous.notes,previous.contact_at,previous.next_follow_up_at)
     IS DISTINCT FROM ROW(p_company,p_status,p_notes,p_contact,p_follow_up) THEN RAISE EXCEPTION 'idempotency_key_reused'; END IF;
   RETURN jsonb_build_object('interactionId',previous.id);
 END IF;
 SELECT * INTO STRICT c FROM public.prospecting_user_companies WHERE id=p_company AND user_id=p_user FOR UPDATE;
 IF p_expected_version IS NULL OR c.version<>p_expected_version THEN RAISE EXCEPTION 'version_conflict'; END IF;
 INSERT INTO public.prospecting_interactions(user_company_id,actor_user_id,idempotency_key,status,notes,contact_at,next_follow_up_at)
 VALUES(p_company,p_user,p_key,p_status,p_notes,p_contact,p_follow_up) RETURNING id INTO entry;
 UPDATE public.prospecting_user_companies SET service_status=p_status,notes=p_notes,last_contact_at=p_contact,
 next_follow_up_at=p_follow_up,version=version+1,updated_at=clock_timestamp() WHERE id=c.id;
 RETURN jsonb_build_object('interactionId',entry);
END $$;

ALTER TABLE public.prospecting_message_schedules
 ADD COLUMN instance_kind text NOT NULL CHECK(instance_kind IN ('sql','legacy')),
 ADD COLUMN whatsapp_instance_id uuid REFERENCES public.whatsapp_instances(id) ON DELETE RESTRICT,
 ADD COLUMN instance_validated_at timestamptz NOT NULL,
 ADD COLUMN instance_validation_actor text NOT NULL CHECK(instance_validation_actor='backend:legacy-broker-access' OR instance_validation_actor='database:whatsapp_instances'),
 ADD COLUMN request_fingerprint jsonb NOT NULL,
 ADD COLUMN lease_token uuid,
 ADD COLUMN cancelled_at timestamptz,
 ADD CONSTRAINT prospecting_schedule_instance CHECK (
  (instance_kind='sql' AND whatsapp_instance_id IS NOT NULL AND instance_validation_actor='database:whatsapp_instances') OR
  (instance_kind='legacy' AND whatsapp_instance_id IS NULL AND instance_validation_actor='backend:legacy-broker-access')),
 ADD CONSTRAINT prospecting_schedule_lease CHECK ((status='processing')=(lease_token IS NOT NULL AND locked_until IS NOT NULL AND worker_id IS NOT NULL)),
 ADD CONSTRAINT prospecting_schedule_sent CHECK ((status='sent')=(sent_at IS NOT NULL)),
 ADD CONSTRAINT prospecting_schedule_cancelled CHECK ((status='cancelled')=(cancelled_at IS NOT NULL)),
 ADD CONSTRAINT prospecting_schedule_timezone CHECK(timezone='America/Sao_Paulo');
CREATE INDEX prospecting_schedule_instance ON public.prospecting_message_schedules(whatsapp_instance_id) WHERE whatsapp_instance_id IS NOT NULL;
CREATE INDEX prospecting_schedule_lease_expiry ON public.prospecting_message_schedules(locked_until) WHERE status='processing';

CREATE FUNCTION public.prospecting_schedule_message(p_user uuid,p_company uuid,p_key text,p_kind text,p_instance uuid,
 p_reference text,p_phone_slot integer,p_message text,p_at timestamptz)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u public.users; c public.prospecting_user_companies; s public.prospecting_company_snapshots;
 old public.prospecting_message_schedules; fp jsonb; job uuid; destination text; reference_value text;
BEGIN
 u:=public.prospecting_lock_user(p_user);
 PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||p_user::text,0));
 fp:=jsonb_build_object('company',p_company,'kind',p_kind,'instance',p_instance,'reference',p_reference,'slot',p_phone_slot,'message',p_message,'at',p_at);
 SELECT * INTO old FROM public.prospecting_message_schedules WHERE owner_user_id=p_user AND idempotency_key=p_key;
 IF FOUND THEN
  IF old.request_fingerprint<>fp THEN RAISE EXCEPTION 'idempotency_key_reused'; END IF;
  RETURN jsonb_build_object('scheduleId',old.id);
 END IF;
 IF p_at IS NULL OR p_at<=clock_timestamp() OR p_phone_slot IS NULL OR p_phone_slot NOT IN (1,2) THEN RAISE EXCEPTION 'invalid_schedule'; END IF;
 SELECT * INTO STRICT c FROM public.prospecting_user_companies WHERE id=p_company AND user_id=p_user;
 SELECT * INTO STRICT s FROM public.prospecting_company_snapshots WHERE id=c.snapshot_id;
 destination:=CASE p_phone_slot WHEN 1 THEN s.mobile_1 ELSE s.mobile_2 END;
 IF destination IS NULL THEN RAISE EXCEPTION 'missing_recipient'; END IF;
 IF p_kind='sql' THEN
  SELECT instance_name INTO STRICT reference_value FROM public.whatsapp_instances
   WHERE id=p_instance AND user_id=p_user AND organization_id=u.organization_id AND status::text='connected' FOR SHARE;
 ELSIF p_kind='legacy' AND p_instance IS NULL AND length(p_reference) BETWEEN 1 AND 200 THEN
  -- Trusted backend resolves CLIENTS_FILE_PATH by accessUserId + organizationId + ativo.
  -- No RPC available to browser roles; the database cannot inspect the legacy JSON file.
  reference_value:=p_reference;
 ELSE RAISE EXCEPTION 'invalid_instance'; END IF;
 INSERT INTO public.prospecting_message_schedules(user_company_id,owner_user_id,organization_id,instance_reference,
 recipient_phone,message,scheduled_at,idempotency_key,instance_kind,whatsapp_instance_id,instance_validated_at,instance_validation_actor,request_fingerprint)
 VALUES(c.id,p_user,u.organization_id,reference_value,destination,p_message,p_at,p_key,p_kind,p_instance,clock_timestamp(),
 CASE p_kind WHEN 'sql' THEN 'database:whatsapp_instances' ELSE 'backend:legacy-broker-access' END,fp) RETURNING id INTO job;
 RETURN jsonb_build_object('scheduleId',job);
END $$;

CREATE FUNCTION public.prospecting_cancel_message(p_user uuid,p_job uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE job public.prospecting_message_schedules;
BEGIN
 PERFORM public.prospecting_lock_user(p_user);
 SELECT * INTO STRICT job FROM public.prospecting_message_schedules WHERE id=p_job AND owner_user_id=p_user FOR UPDATE;
 IF job.status='cancelled' THEN RETURN jsonb_build_object('scheduleId',job.id,'status','cancelled'); END IF;
 IF job.status NOT IN ('pending','failed') THEN RAISE EXCEPTION 'schedule_not_cancellable'; END IF;
 UPDATE public.prospecting_message_schedules SET status='cancelled',cancelled_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=job.id;
 RETURN jsonb_build_object('scheduleId',job.id,'status','cancelled');
END $$;

ALTER TABLE public.prospecting_lead_exports
 ADD COLUMN organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE RESTRICT,
 ADD COLUMN source text NOT NULL DEFAULT 'Prospecção de Empresas' CHECK(source='Prospecção de Empresas'),
 ADD COLUMN destination_kind text NOT NULL DEFAULT 'legacy_json' CHECK(destination_kind='legacy_json'),
 ADD COLUMN lease_token uuid,
 ADD CONSTRAINT prospecting_export_lease CHECK ((status='processing')=(lease_token IS NOT NULL AND locked_until IS NOT NULL AND worker_id IS NOT NULL));
CREATE INDEX prospecting_export_org ON public.prospecting_lead_exports(organization_id);
CREATE INDEX prospecting_export_lease_expiry ON public.prospecting_lead_exports(locked_until) WHERE status='processing';

CREATE FUNCTION public.prospecting_request_export(p_user uuid,p_company uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE u public.users; c public.prospecting_user_companies; job public.prospecting_lead_exports;
BEGIN
 u:=public.prospecting_lock_user(p_user);
 PERFORM pg_advisory_xact_lock(hashtextextended('prospecting:'||p_user::text,0));
 SELECT * INTO STRICT c FROM public.prospecting_user_companies WHERE id=p_company AND user_id=p_user;
 INSERT INTO public.prospecting_lead_exports(user_company_id,owner_user_id,organization_id)
 VALUES(c.id,p_user,u.organization_id) ON CONFLICT(user_company_id) DO NOTHING;
 SELECT * INTO STRICT job FROM public.prospecting_lead_exports WHERE user_company_id=c.id;
 RETURN jsonb_build_object('exportId',job.id,'operationKey',job.operation_key,'source',job.source);
END $$;

-- Worker lease primitives do not send messages or create leads. Expired leases
-- become unknown and are never automatically retried after an ambiguous side effect.
CREATE FUNCTION public.prospecting_claim_jobs(p_kind text,p_worker uuid,p_limit integer DEFAULT 20)
RETURNS SETOF jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE table_name text; due text;
BEGIN
 IF p_worker IS NULL OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'invalid_worker_claim'; END IF;
 IF p_kind='message' THEN table_name:='prospecting_message_schedules'; due:='scheduled_at';
 ELSIF p_kind='export' THEN table_name:='prospecting_lead_exports'; due:='created_at'; ELSE RAISE EXCEPTION 'invalid_job_kind'; END IF;
 EXECUTE format('UPDATE public.%I SET status=''unknown'', lease_token=NULL,worker_id=NULL,locked_until=NULL,last_error_code=''lease_expired'' WHERE status=''processing'' AND locked_until<=clock_timestamp()',table_name);
 RETURN QUERY EXECUTE format('WITH picked AS (
 SELECT j.id FROM public.%I j JOIN public.users u ON u.id=j.owner_user_id JOIN public.organizations o ON o.id=j.organization_id
 WHERE j.status=''pending'' AND j.%I<=clock_timestamp() AND u.organization_id=j.organization_id
 AND u.status::text=''active'' AND u.role::text IN (''broker'',''supervisor'') AND o.status::text=''active''
 ORDER BY j.%I,j.id FOR UPDATE OF j SKIP LOCKED LIMIT $1)
 UPDATE public.%I j SET status=''processing'',worker_id=$2,lease_token=gen_random_uuid(),
 locked_until=clock_timestamp()+interval ''2 minutes'',attempt_count=attempt_count+1 FROM picked WHERE j.id=picked.id RETURNING to_jsonb(j)',table_name,due,due,table_name)
 USING p_limit,p_worker;
END $$;

CREATE FUNCTION public.prospecting_finish_job(p_kind text,p_job uuid,p_worker uuid,p_lease uuid,p_outcome text,p_external_id text,p_error text DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE affected integer;
BEGIN
 IF p_outcome IS NULL OR p_outcome NOT IN ('success','failed','unknown') OR length(coalesce(p_external_id,''))>200 OR length(coalesce(p_error,''))>100 THEN RAISE EXCEPTION 'invalid_job_result'; END IF;
 IF p_outcome='success' AND nullif(btrim(p_external_id),'') IS NULL THEN RAISE EXCEPTION 'missing_external_id'; END IF;
 IF p_kind='message' THEN
  UPDATE public.prospecting_message_schedules SET status=CASE p_outcome WHEN 'success' THEN 'sent' ELSE p_outcome END,
   provider_message_id=p_external_id,last_error_code=p_error,sent_at=CASE WHEN p_outcome='success' THEN clock_timestamp() END,
   lease_token=NULL,locked_until=NULL,worker_id=NULL,updated_at=clock_timestamp()
  WHERE id=p_job AND status='processing' AND worker_id=p_worker AND lease_token=p_lease AND locked_until>clock_timestamp();
 ELSIF p_kind='export' THEN
  UPDATE public.prospecting_lead_exports SET status=CASE p_outcome WHEN 'success' THEN 'exported' ELSE p_outcome END,
   target_lead_id=p_external_id,last_error_code=p_error,exported_at=CASE WHEN p_outcome='success' THEN clock_timestamp() END,
   lease_token=NULL,locked_until=NULL,worker_id=NULL
  WHERE id=p_job AND status='processing' AND worker_id=p_worker AND lease_token=p_lease AND locked_until>clock_timestamp();
 ELSE RAISE EXCEPTION 'invalid_job_kind'; END IF;
 GET DIAGNOSTICS affected=ROW_COUNT;
 RETURN affected=1;
END $$;

REVOKE ALL ON FUNCTION public.prospecting_check_movement(), public.prospecting_check_assignment(),
 public.prospecting_record_interaction(uuid,uuid,text,text,text,timestamptz,timestamptz,bigint),
 public.prospecting_schedule_message(uuid,uuid,text,text,uuid,text,integer,text,timestamptz),
 public.prospecting_cancel_message(uuid,uuid), public.prospecting_request_export(uuid,uuid),
 public.prospecting_claim_jobs(text,uuid,integer), public.prospecting_finish_job(text,uuid,uuid,uuid,text,text,text)
 FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.prospecting_record_interaction(uuid,uuid,text,text,text,timestamptz,timestamptz,bigint),
 public.prospecting_schedule_message(uuid,uuid,text,text,uuid,text,integer,text,timestamptz),
 public.prospecting_cancel_message(uuid,uuid), public.prospecting_request_export(uuid,uuid),
 public.prospecting_claim_jobs(text,uuid,integer), public.prospecting_finish_job(text,uuid,uuid,uuid,text,text,text) TO service_role;

-- No anon/authenticated RLS policies: deny by default. service_role is server-only.
-- No triggers/jobs on existing tables. No cron registration, no data backfill.
COMMIT;
