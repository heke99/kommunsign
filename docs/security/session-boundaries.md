# Sessionsgränser

Tenant-, plattforms-, sökande- och signerarsessioner använder separata cookie-namn. Cookies skapas med Path `/`, HttpOnly, SameSite Lax och Secure i produktion. Domain-attribut sätts aldrig.

Databasen lagrar tokenhash, hostname, boundary, subject och expiry. En session som skapats för `signering.kungalv.se` ska inte accepteras på en annan host. Engångskoder är signerade, kortlivade, destinationsbundna och atomiskt konsumerade.

En central `.kommunsign.se`-cookie är uttryckligen förbjuden som huvudmodell.
