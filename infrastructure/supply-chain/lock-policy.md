# Supply-chain lock policy

GitHub Actions är fastlåsta till verifierade fulla commit-SHA:n i workflowfilen. Lokala Docker Compose-images använder exakta versions-/release-taggar för att miljön ska kunna startas. Produktionspipelinen måste lösa dessa taggar till registry-digests, uppdatera det signerade release-manifestet och ersätta Kubernetes-image innan deployment. `registry.invalid` är en avsiktlig fail-closed-referens i basmanifestet.
