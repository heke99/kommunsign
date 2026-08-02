FROM eclipse-temurin:21.0.10_7-jdk AS build
WORKDIR /src
COPY services/validation-service/src ./src
RUN mkdir -p /out && find src -name '*.java' -print0 | xargs -0 javac --release 21 -d /out

FROM gcr.io/distroless/java21-debian12:nonroot
COPY --from=build /out /app
WORKDIR /app
USER nonroot
ENTRYPOINT ["java","-cp","/app","se.kommunsign.validation.ValidationServiceApplication"]
