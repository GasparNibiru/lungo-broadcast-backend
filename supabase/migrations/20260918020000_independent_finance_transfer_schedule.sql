alter table finance_sales
  add column if not exists first_transfer_date date;

comment on column finance_sales.first_transfer_date is
  'Independent first due date for the broker transfer schedule.';
