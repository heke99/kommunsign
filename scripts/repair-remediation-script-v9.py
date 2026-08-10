from pathlib import Path
p = Path('scripts/apply-full-product-remediation.py')
s = p.read_text()
s = s.replace("marker = re.search(r'interface CaseRow\\s*\\{.*?\\n\\}', s, re.S)\n    if not marker:\n        raise SystemExit('CaseRow interface not found')", "marker = re.search(r'const caseSelect =', s)\n    if not marker:\n        raise SystemExit('caseSelect marker not found')", 1)
s = s.replace("s = s[:marker.end()] + detail + s[marker.end():]", "s = s[:marker.start()] + detail + s[marker.start():]", 1)
s = s.replace("        };\n      });\n    },\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", "        };\n      });\n    },\n    async list(context, page)\n'''\ns, n = re.subn(get_pattern, get_replacement, s, count=1, flags=re.S)", 1)
old = "    r'''    for \\(const membership of memberships\\.rows\\) \\{\\n      try \\{ return await primaryTenantDestination\\(controlDatabase, membership\\.tenant_id, tenantDiscoveryHostname\\); \\}\\n      catch \\(cause\\) \\{ if \\(\\.\\.\\.\\(cause instanceof Error\\) \\|\\| cause\\.message !== 'ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE'\\) throw cause; \\}\\n    \\}\\n    throw new Error\\('AUTH_ACCOUNT_NOT_AUTHORIZED'\\);'''"
new = "    r'''    for \\(const membership of memberships\\.rows\\) \\{.*?    \\}\\n    throw new Error\\('AUTH_ACCOUNT_NOT_AUTHORIZED'\\);'''"
if old not in s:
    raise SystemExit('auth source pattern not found')
s = s.replace(old, new, 1)
p.write_text(s)
print('REMEDIATION_SCRIPT_V9_REPAIRED')
