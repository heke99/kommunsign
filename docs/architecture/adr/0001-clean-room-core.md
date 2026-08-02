# ADR 0001 – Clean-room core före donorimport

**Status:** accepted

KommunSign-kärnan byggs originalt innan donorimport. Skälen är licensrisk, behov av svensk offentlig signaturmodell och kravet att inte ärva en modell där en visuell signaturbild förväxlas med kryptografisk underskrift.

Donorprojekt får senare bidra med avgränsade UI/workflow-delar efter permission gate, commit pin, LOC-mätning och varumärkesrensning.
