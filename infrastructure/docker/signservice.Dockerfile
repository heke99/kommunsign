# Built with Maven since ADR 0004: this service links the Sweden Connect signing
# stack and can no longer be compiled with bare javac.
#
# Dependencies are resolved in a separate layer from the source copy so that a
# code change does not re-download the world, and `-o` on the build step forces
# the resolved set to be exactly what the pinned poms produced.
FROM maven:3.9.11-eclipse-temurin-21 AS build
WORKDIR /src
COPY services/pom.xml ./services/pom.xml
COPY services/commons/pom.xml ./services/commons/pom.xml
COPY services/signservice/pom.xml ./services/signservice/pom.xml
COPY services/validation-service/pom.xml ./services/validation-service/pom.xml
COPY services/integration-tests/pom.xml ./services/integration-tests/pom.xml
RUN mvn -B -f services/pom.xml -pl commons,signservice -am dependency:go-offline

COPY services ./services
RUN mvn -B -o -f services/pom.xml -pl commons,signservice -am package -DskipTests

FROM gcr.io/distroless/java21-debian12:nonroot
COPY --from=build /src/services/signservice/target/kommunsign-signservice.jar /app/kommunsign-signservice.jar
COPY --from=build /src/services/signservice/target/lib /app/lib
WORKDIR /app
USER nonroot
EXPOSE 8081
ENTRYPOINT ["java","-jar","/app/kommunsign-signservice.jar"]
