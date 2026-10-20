-- F-616 image identity is frozen with the catalogue revision. Reuse the core
-- content-addressed file authority; old packaged sample illustrations stay valid.
alter table product_catalogue_versions add column image_file_id uuid references files(id);
create index product_catalogue_versions_image on product_catalogue_versions(image_file_id) where image_file_id is not null;
