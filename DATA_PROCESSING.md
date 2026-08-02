# Personuppgiftsbehandling

Standardrollfördelning:

- Kunden/kommunen är personuppgiftsansvarig.
- KommunSign är personuppgiftsbiträde.
- Identitets-, drift-, e-post- och arkivleverantörer är underbiträden enligt avtal.

Control plane får endast lagra plattformsmetadata och secret references. Dokument, personnummer, signaturbevis och verksamhetsdata ska ligga i tenantens data plane.

Personnummer ska krypteras fältnivåmässigt. Sökning sker via tenantunik blind index-token. Signerade handlingar ändras inte vid rättelse; rättelse sker genom metadata eller ny handling enligt kundens instruktion.
