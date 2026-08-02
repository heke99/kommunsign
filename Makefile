.PHONY: verify build test package
verify:
	npm run verify
build:
	npm run build
test:
	npm test
package:
	npm run package:release
