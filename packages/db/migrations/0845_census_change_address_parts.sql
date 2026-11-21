-- SP-0220: Edit customer sends the structured address (Street 1, barangay, city, province); the server builds the line.
ALTER TABLE census_captures ADD COLUMN address_parts jsonb CHECK (address_parts IS NULL OR jsonb_typeof(address_parts) = 'object');
