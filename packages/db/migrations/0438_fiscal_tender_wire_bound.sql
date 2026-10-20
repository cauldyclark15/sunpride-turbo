-- F-111: retain the frozen native v1 reference-label bound.
alter table fiscal_tender_rules add constraint fiscal_tender_reference_label_length
 check(reference_label is null or length(reference_label) between 1 and 40);
