# Java boundary services

Tjänsterna är avsiktligt separerade från Node-applikationen:

- `signservice` – Sweden Connect SignService, engångscertifikat, PAdES och HSM/TSP.
- `validation-service` – EU DSS, trusted lists, OCSP/CRL, TSA och LT/LTA.

Den lokala koden kompilerar med Java 21 men blockerar produktionsoperationer tills officiella dependencies har fastlåsta versioner och riktiga certifikat/avtal. Detta förhindrar att plattformen felaktigt registrerar en vanlig PDF-stämpel som avancerad elektronisk underskrift.
