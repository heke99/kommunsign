import { access, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

function parseScalar(raw) {
  const value = raw.trim();
  if (value === 'null') return null;
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value.replace(/^['"]|['"]$/g, '');
}

export function parseSourceInventory(text) {
  const maximumMatch = text.match(/maximum_percent_per_donor:\s*(\d+)/);
  if (!maximumMatch) throw new Error('Source inventory lacks maximum_percent_per_donor');
  const sources = [];
  let current = null;
  for (const line of text.split(/\r?\n/)) {
    const start = line.match(/^\s{2}-\s+project:\s*(.+)$/);
    if (start) {
      current = { project: parseScalar(start[1]) };
      sources.push(current);
      continue;
    }
    const field = line.match(/^\s{4}([a-z0-9_]+):\s*(.*)$/i);
    if (field && current) current[field[1]] = parseScalar(field[2]);
  }
  if (sources.length === 0) throw new Error('Source inventory contains no donor records');
  return { maximumPercent: Number(maximumMatch[1]), sources };
}

async function sha256File(path) {
  const bytes = await readFile(path);
  return createHash('sha256').update(bytes).digest('hex');
}

export async function verifyProvenance(root = '.') {
  const inventoryPath = `${root}/upstream/manifests/source-inventory.yaml`;
  const reuseMapPath = `${root}/upstream/manifests/reuse-map.json`;
  const inventory = parseSourceInventory(await readFile(inventoryPath, 'utf8'));
  const reuseMap = JSON.parse(await readFile(reuseMapPath, 'utf8'));
  if (reuseMap.schema !== 'kommunsign.reuse-map.v1' || !Array.isArray(reuseMap.entries)) {
    throw new Error('Reuse map has an unsupported schema');
  }
  if (inventory.maximumPercent < 1 || inventory.maximumPercent > 85) {
    throw new Error('maximum_percent_per_donor must be between 1 and 85');
  }

  const knownProjects = new Set(inventory.sources.map((source) => source.project));
  for (const entry of reuseMap.entries) {
    if (!knownProjects.has(entry.project)) throw new Error(`Reuse map contains unknown donor: ${entry.project}`);
    if (typeof entry.destination_path !== 'string' || !entry.destination_path) throw new Error('Reuse map entry lacks destination_path');
    if (!Number.isSafeInteger(entry.reused_loc) || entry.reused_loc < 1) throw new Error('Reuse map reused_loc must be a positive integer');
  }

  let totalReused = 0;
  for (const source of inventory.sources) {
    if (typeof source.repository !== 'string' || !source.repository.includes('/')) throw new Error(`${source.project}: repository is invalid`);
    if (typeof source.pinned_commit !== 'string' || !/^[0-9a-f]{40}$/.test(source.pinned_commit)) {
      throw new Error(`${source.project}: exact 40-character commit pin is required`);
    }
    if (!Number.isSafeInteger(source.original_loc) || source.original_loc < 0) throw new Error(`${source.project}: original_loc is invalid`);
    if (!Number.isSafeInteger(source.reused_loc) || source.reused_loc < 0) throw new Error(`${source.project}: reused_loc is invalid`);
    if (source.reused_loc > 0 && source.original_loc === 0) throw new Error(`${source.project}: original_loc is required when code is reused`);
    const percent = source.original_loc === 0 ? 0 : (source.reused_loc / source.original_loc) * 100;
    if (percent > inventory.maximumPercent + Number.EPSILON) {
      throw new Error(`${source.project}: ${percent.toFixed(2)}% reuse exceeds ${inventory.maximumPercent}%`);
    }
    if (source.imported !== (source.reused_loc > 0)) {
      throw new Error(`${source.project}: imported must exactly match whether reused_loc is greater than zero`);
    }
    await access(`${root}/${source.permission_file}`);

    const mappedLoc = reuseMap.entries
      .filter((entry) => entry.project === source.project)
      .reduce((sum, entry) => sum + entry.reused_loc, 0);
    if (mappedLoc !== source.reused_loc) throw new Error(`${source.project}: reuse-map LOC ${mappedLoc} does not match inventory LOC ${source.reused_loc}`);

    if (source.imported) {
      if (typeof source.permission_evidence !== 'string' || !source.permission_evidence) {
        throw new Error(`${source.project}: imported code requires permission_evidence`);
      }
      if (typeof source.permission_sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(source.permission_sha256)) {
        throw new Error(`${source.project}: imported code requires permission_sha256`);
      }
      if (source.permission_status !== 'verified') throw new Error(`${source.project}: imported code requires permission_status=verified`);
      const evidencePath = `${root}/${source.permission_evidence}`;
      await access(evidencePath);
      if (await sha256File(evidencePath) !== source.permission_sha256) throw new Error(`${source.project}: permission evidence checksum mismatch`);
      if (String(source.gate).startsWith('blocked_')) throw new Error(`${source.project}: imported code cannot retain a blocked gate`);
    }
    totalReused += source.reused_loc;
  }
  return { ...inventory, totalReused, reuseEntries: reuseMap.entries.length };
}
