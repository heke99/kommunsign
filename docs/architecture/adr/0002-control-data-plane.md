# ADR 0002 – Control plane och utbytbara data planes

**Status:** accepted

Control plane innehåller endast plattformsmetadata. Tenantdata ligger i data plane och samma applikationskod väljer anslutning/deployment genom en serververifierad tenantkontext. Kundunika forks är förbjudna.
