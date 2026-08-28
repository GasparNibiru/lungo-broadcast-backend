create table if not exists public.brazil_partners (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 2 and 160),
  state char(2) not null check (state ~ '^[A-Z]{2}$'),
  contact_name text,
  whatsapp text not null check (whatsapp ~ '^[0-9]{10,15}$'),
  products text[] not null default '{}',
  notes text,
  active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists brazil_partners_state_active_idx
  on public.brazil_partners (state, active, sort_order, name);

alter table public.brazil_partners enable row level security;
revoke all on public.brazil_partners from public, anon, authenticated;

insert into public.brazil_partners (name, state, contact_name, whatsapp, products, sort_order)
select seed.name, seed.state, seed.contact_name, seed.whatsapp, seed.products, seed.sort_order
from (values
  ('Natuseg Assessoria','AC',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','AL',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Mais Você','Amil','Vallor'],10),
  ('Natuseg Assessoria','AP',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','AM',null,'557182802865',array['SulAmérica','Hapvida','TEC','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','BA',null,'557182802865',array['Seguros Unimed','SulAmérica','Assim Saúde','Brasil Saúde','Hapvida','AllCare','TEC','Qualicorp','Affix','Extramed','Boa Saúde','Vitalmed','Bradesco','Quali Saúde','Mais Você','Vallor'],10),
  ('Natuseg Assessoria','CE',null,'557182802865',array['SulAmérica','Hapvida','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','DF',null,'557182802865',array['Seguros Unimed','SulAmérica','Hapvida','TEC','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','ES',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Quali Saúde','Amil','Vallor'],10),
  ('Natuseg Assessoria','GO',null,'557182802865',array['SulAmérica','Hapvida','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','MA',null,'557182802865',array['Seguros Unimed','SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','MT',null,'557182802865',array['SulAmérica','Hapvida','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','MS',null,'557182802865',array['SulAmérica','Hapvida','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','MG',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Mais Você','Amil','Vallor'],10),
  ('Natuseg Assessoria','PA',null,'557182802865',array['SulAmérica','Hapvida','TEC','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','PB',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','PR',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','PE',null,'557182802865',array['SulAmérica','Hapvida','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','PI',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','RJ',null,'557182802865',array['SulAmérica','Assim Saúde','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','RN',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','RS',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','RO',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','RR',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','SC',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','SP',null,'557182802865',array['Seguros Unimed','SulAmérica','TEC','Qualicorp','Affix','Extramed','Bradesco','Quali Saúde','Amil','Vallor'],10),
  ('Natuseg Assessoria','SE',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('Natuseg Assessoria','TO',null,'557182802865',array['SulAmérica','Qualicorp','Affix','Extramed','Bradesco','Amil','Vallor'],10),
  ('MultPlanos','ES',null,'5527999759813','{}',20), ('TN Assistenza Sociale Corretora de Seguros Ltda','SC','Ronaldo','554888439869','{}',20),
  ('Saúde & Vida','RN','Ana Lucia','558488943986','{}',20), ('Guararapes Saúde','PE',null,'558189264598','{}',20),
  ('OMNI Corretora','AM','Gaspar','55992102864','{}',20), ('Líder Corretora','AM','Neia','5592991420458','{}',30),
  ('Soluções Saúde','RS','Josnei','555193812425','{}',20), ('Affinity Assessoria','SP',null,'551131233009','{}',20),
  ('Affinity Assessoria','RJ',null,'551131233009','{}',20), ('VS Assessoria','PA','Vagner','556195587821','{}',20),
  ('VS Assessoria','DF','Vagner','556195587821','{}',20), ('VS Assessoria','MA','Vagner','556195587821','{}',20),
  ('VS Assessoria','GO','Vagner','556195587821','{}',20)
) as seed(name,state,contact_name,whatsapp,products,sort_order)
where not exists (select 1 from public.brazil_partners);
