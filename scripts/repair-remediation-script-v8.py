from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
s = s.replace("marker = re.search(r'interface CaseRow\\s*\\{.*?\\n\\}', s, re.S)\n    if not marker:\n        raise SystemExit('CaseRow interface not found')", "marker = re.search(r'const caseSelect =', s)\n    if not marker:\n        raise SystemExit('caseSelect marker not found')", 1)
s = s.replace("s = s[:marker.end()] + detail + s[marker.end():]", "s = s[:marker.start()] + detail + s[marker.start():]", 1)
s = s.replace("        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", "        };\n      });\n    },\n    async list(context, page)\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", 1)
start = s.index('# AUTH: resolve eligible tenant memberships concurrently.')
end = s.index('# TENANT PORTAL: remove browser-only authoritative state.')
auth = '''# AUTH: resolve eligible tenant memberships concurrently.
replace_once(
    'apps/api/src/production-adapters/postgres/authentication-repository.ts',
    "r'''    for \\(const membership of memberships\\.rows\\) \\{.*?    \\}\\n    throw new Error\\('AUTH_ACCOUNT_NOT_AUTHORIZED'\\);'''",
    '''    const destinations = await Promise.all(memberships.rows.map(async (membership) => {
      try { return await primaryTenantDestination(controlDatabase, membership.tenant_id, tenantDiscoveryHostname); }
      catch (cause) {
        if (cause instanceof Error && cause.message === 'ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE') return null;
        throw cause;
      }
    }));
    const destination = destinations.find((value): value is ResolvedDestination => value !== null);
    if (destination) return destination;
    throw new Error('AUTH_ACCOUNT_NOT_AUTHORIZED');'''
)

'''
# Convert the quoted pattern expression into normal Python source before writing the script.
auth = auth.replace('"r\'\'\'    for', "r'''    for").replace(";'''\",", ";''' ,")
s = s[:start] + auth + s[end:]
p.write_text(s)
print('REMEDIATION_SCRIPT_V8_REPAIRED')
