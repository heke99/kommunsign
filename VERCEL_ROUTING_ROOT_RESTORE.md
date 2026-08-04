# Vercel routing root restore

- Återställer `build/vercel/index.html` för rootdomänen och Vercels deployment-URL.
- Använder ordnade `routes` så `app.kommunsign.se` och `admin.kommunsign.se` väljs före filsystemets rootfil.
- Pekar portalrötter uttryckligen på respektive `index.html`.
- Mappar portalernas statiska CSS/JS/assets till rätt interna portalmapp.
- Behåller publika paths `/ansok/`, `/signera/` och `/verifiera/` i filsystemet.
