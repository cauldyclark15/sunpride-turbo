-- F-509: operational requests do not count as recovered until SAP acknowledges.
alter table deductions add column source_mode text not null default 'sample'
  check(source_mode in ('sample','operational'));
alter table deductions add column written_off_centavos bigint not null default 0
  check(written_off_centavos>=0);
alter table deductions add constraint deduction_resolution_bound
  check(recovered_centavos+written_off_centavos<=amount_centavos);
create index tpm_deduction_postings on tpm_posting_instructions ((payload->>'deductionId'))
  where payload ? 'deductionId';
