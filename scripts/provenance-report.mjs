import { verifyProvenance } from './provenance-lib.mjs';
const report = await verifyProvenance('.');
console.log('Donor provenance report');
console.log(`Maximum permitted reuse per donor: ${report.maximumPercent}%`);
for (const source of report.sources) {
  const percent = source.original_loc === 0 ? 0 : (source.reused_loc / source.original_loc) * 100;
  console.log(`${source.project}: ${source.reused_loc}/${source.original_loc} LOC (${percent.toFixed(2)}%), pin ${source.pinned_commit}, permission ${source.permission_status}`);
}
