import { verifyProvenance } from './provenance-lib.mjs';
const report = await verifyProvenance('.');
console.log(`provenance verification: OK (${report.totalReused} donor LOC, ${report.sources.length} pinned donors, ${report.reuseEntries} mapped imports)`);
