---
type: llm
focus: last_message
---

PASS se il rapporto riporta un piano che compone S.STD.ADM.CFP.0014 con la deviazione di C.ACME.ADM.CFP.0002
(passo di pubblicazione esplicita), con CHK pre (S.STD.ADM.CHK.0019, S.STD.ADM.CHK.0051), snapshot prima del
primo salvataggio, rollback con S.STD.ADM.CFP.0015 (disattivare), un verificatore e le approvazioni come tipi.
FAIL se il piano è applicato sul tenant, manca il rollback, o le approvazioni sono scritte come frasi.
