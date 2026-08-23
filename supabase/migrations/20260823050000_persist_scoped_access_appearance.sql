alter table organizations
  add column if not exists sidebar_color text,
  add column if not exists background_key text;

alter table users
  add column if not exists profile_photo_url text,
  add column if not exists sidebar_color text,
  add column if not exists background_key text,
  add column if not exists preferred_theme text;

alter table organizations drop constraint if exists organizations_sidebar_color_valid;
alter table organizations add constraint organizations_sidebar_color_valid
  check (sidebar_color is null or sidebar_color ~ '^#[0-9A-Fa-f]{6}$');
alter table organizations drop constraint if exists organizations_background_key_valid;
alter table organizations add constraint organizations_background_key_valid
  check (background_key is null or background_key in ('none','mountain-lake','misty-forest','tropical-beach','green-hills','night-city'));

alter table users drop constraint if exists users_sidebar_color_valid;
alter table users add constraint users_sidebar_color_valid
  check (sidebar_color is null or sidebar_color ~ '^#[0-9A-Fa-f]{6}$');
alter table users drop constraint if exists users_background_key_valid;
alter table users add constraint users_background_key_valid
  check (background_key is null or background_key in ('none','mountain-lake','misty-forest','tropical-beach','green-hills','night-city'));
alter table users drop constraint if exists users_preferred_theme_valid;
alter table users add constraint users_preferred_theme_valid
  check (preferred_theme is null or preferred_theme in ('dark','light'));
