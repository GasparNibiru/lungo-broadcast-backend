drop index if exists organizations_document_number_unique_idx;

create unique index organizations_document_number_unique_idx
  on organizations (btrim(document_number))
  where document_number is not null
    and status <> 'inactive';
