# Permission evidence required before donor import

The project owner has stated that written permission exists to reuse up to 85 percent from each named donor project. That statement is recorded as `claimed_not_verified` in the source inventory, but it is not a substitute for repository-stored, reviewable evidence.

Before any donor record may set `imported: true`, place a non-placeholder copy of the applicable permission or license review in that donor's directory and record:

- the exact evidence path;
- SHA-256 of the evidence file;
- rights holder and effective date;
- allowed code scope and excluded code;
- commercial SaaS, modification, distribution and closed-source rights;
- attribution, publication, sublicensing and trademark obligations;
- the approved percentage calculation method.

The build rejects imported donor code when this evidence, commit pin, LOC accounting or per-file reuse map is missing or when reuse exceeds 85 percent.
