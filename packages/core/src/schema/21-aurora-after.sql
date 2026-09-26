-- The step after an Aurora deposit settles: fund Perpl (and open the asked position) or convert USDC to AUSD on the phone.
alter table aurora_deposits add column if not exists after_status text;   -- funding | funded | opened | ready | needs_conversion | converted | needs_session | failed
alter table aurora_deposits add column if not exists after_result jsonb;
