package se.kommunsign.validation;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.io.Reader;
import java.io.StringReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.xml.XMLConstants;
import javax.xml.transform.stream.StreamSource;
import javax.xml.validation.Schema;
import javax.xml.validation.SchemaFactory;
import javax.xml.validation.Validator;
import org.w3c.dom.ls.LSInput;
import org.w3c.dom.ls.LSResourceResolver;
import org.xml.sax.ErrorHandler;
import org.xml.sax.SAXParseException;

/**
 * Validates an FGS submission descriptor against the schema set Riksarkivet
 * publishes.
 *
 * The archive package already followed the published profile — the profile URI,
 * the ExtensionMETS namespace, CHECKSUMTYPE and the structMap were taken from
 * it rather than guessed. But "follows the profile" and "validated against the
 * profile's schemas" are different claims, and only the second one is checked
 * by something other than the person who wrote the file.
 *
 * Two things this deliberately does not do.
 *
 * It does not fetch the schemas. A conformance check that depends on a remote
 * host is not reproducible: it silently becomes a different check when the host
 * changes the file, and no check at all when the host is down. The XSDs are
 * bundled, their digests recorded, and every reference below resolves to the
 * bundled copy.
 *
 * It does not claim conformance with the *receiving* archive. An archive picks
 * its FGS version and may mandate local profile extensions, so passing here is
 * necessary and not sufficient. That remaining distance is tracked as an
 * external blocker rather than papered over.
 */
public final class FgsPackageValidator {

    /** Every schema the profile references, and nothing else may be loaded. */
    private static final Map<String, String> BUNDLED_SCHEMAS = Map.of(
        "http://xml.ra.se/e-arkiv/METS/CSPackageMETS.xsd", "/fgs/CSPackageMETS.xsd",
        "http://xml.ra.se/e-arkiv/METS/CSPackageExtensionMETS.xsd", "/fgs/CSPackageExtensionMETS.xsd",
        "http://xml.ra.se/e-arkiv/xlink/xlink.xsd", "/fgs/xlink.xsd",
        "xlink.xsd", "/fgs/xlink.xsd");

    private static final int MAX_REPORTED_PROBLEMS = 20;

    private final Schema schema;

    public FgsPackageValidator() {
        try {
            SchemaFactory factory = SchemaFactory.newInstance(XMLConstants.W3C_XML_SCHEMA_NS_URI);
            // The schemas themselves are parsed by this factory, so it is hardened
            // the same way the document parsers are: nothing outside the bundle
            // may be reached, whatever a schema asks for.
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            factory.setResourceResolver(new BundledSchemaResolver());
            this.schema = factory.newSchema(new StreamSource[] {
                bundledSource("/fgs/CSPackageMETS.xsd"),
                bundledSource("/fgs/CSPackageExtensionMETS.xsd"),
            });
        } catch (Exception exception) {
            throw new IllegalStateException("FGS schema set could not be loaded", exception);
        }
    }

    /**
     * @return a report in the same shape the other validators return: a result,
     *         and the checks that produced it.
     */
    public Map<String, Object> validate(byte[] descriptor) {
        List<Map<String, Object>> checks = new ArrayList<>();
        List<String> problems = new ArrayList<>();

        boolean wellFormedAndValid = false;
        try {
            Validator validator = schema.newValidator();
            validator.setProperty(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            validator.setProperty(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            validator.setErrorHandler(new CollectingErrorHandler(problems));
            validator.validate(new StreamSource(new ByteArrayInputStream(descriptor)));
            wellFormedAndValid = problems.isEmpty();
        } catch (Exception exception) {
            // A parse failure is a validation result, not a service fault: the
            // document is simply not a valid package descriptor.
            if (problems.isEmpty()) problems.add(exception.getClass().getSimpleName());
        }

        checks.add(check("FGS_SCHEMA_VALID", wellFormedAndValid,
            wellFormedAndValid ? "" : String.join("; ", problems.subList(0, Math.min(problems.size(), MAX_REPORTED_PROBLEMS)))));

        Map<String, Object> report = new LinkedHashMap<>();
        report.put("result", wellFormedAndValid ? "PASS" : "FAIL");
        report.put("engine", "javax.xml.validation");
        report.put("specification", "RAFGS1V1.2");
        report.put("profileUri", "http://xml.ra.se/e-arkiv/METS/CommonSpecificationSwedenPackageProfile.xml");
        // Said out loud in every report, so a reader cannot mistake this for
        // conformance with the archive that will actually receive the package.
        report.put("schemaSource", "Riksarkivet published schema set, bundled with this service");
        report.put("receivingArchiveSchemaValidated", false);
        report.put("checks", checks);
        return report;
    }

    private static Map<String, Object> check(String name, boolean passed, String detail) {
        Map<String, Object> entry = new LinkedHashMap<>();
        entry.put("name", name);
        entry.put("passed", passed);
        if (!detail.isEmpty()) entry.put("detail", detail);
        return entry;
    }

    private static StreamSource bundledSource(String resource) {
        InputStream stream = FgsPackageValidator.class.getResourceAsStream(resource);
        if (stream == null) throw new IllegalStateException("bundled schema missing: " + resource);
        StreamSource source = new StreamSource(stream);
        // A system ID is needed for relative imports to resolve, and it must be
        // the published URI so the resolver below recognises what is asked for.
        source.setSystemId(resource);
        return source;
    }

    /** Resolves every schema reference to the bundled copy, or to nothing. */
    private static final class BundledSchemaResolver implements LSResourceResolver {
        @Override
        public LSInput resolveResource(String type, String namespaceUri, String publicId, String systemId, String baseUri) {
            String resource = systemId == null ? null : BUNDLED_SCHEMAS.get(systemId);
            if (resource == null && systemId != null) {
                // Imports are written relative in some of the published files.
                int slash = systemId.lastIndexOf('/');
                String name = slash >= 0 ? systemId.substring(slash + 1) : systemId;
                resource = BUNDLED_SCHEMAS.get(name);
            }
            if (resource == null) return null;
            InputStream stream = FgsPackageValidator.class.getResourceAsStream(resource);
            if (stream == null) return null;
            return new BundledInput(systemId, publicId, stream);
        }
    }

    private static final class BundledInput implements LSInput {
        private final String systemId;
        private final String publicId;
        private InputStream byteStream;

        private BundledInput(String systemId, String publicId, InputStream byteStream) {
            this.systemId = systemId;
            this.publicId = publicId;
            this.byteStream = byteStream;
        }

        @Override public Reader getCharacterStream() { return null; }
        @Override public void setCharacterStream(Reader characterStream) {}
        @Override public InputStream getByteStream() { return byteStream; }
        @Override public void setByteStream(InputStream stream) { this.byteStream = stream; }
        @Override public String getStringData() { return null; }
        @Override public void setStringData(String stringData) {}
        @Override public String getSystemId() { return systemId; }
        @Override public void setSystemId(String value) {}
        @Override public String getPublicId() { return publicId; }
        @Override public void setPublicId(String value) {}
        @Override public String getBaseURI() { return null; }
        @Override public void setBaseURI(String baseUri) {}
        @Override public String getEncoding() { return StandardCharsets.UTF_8.name(); }
        @Override public void setEncoding(String encoding) {}
        @Override public boolean getCertifiedText() { return false; }
        @Override public void setCertifiedText(boolean certifiedText) {}
    }

    /**
     * Collects problems instead of throwing on the first one.
     *
     * A report naming one error sends the author round the loop once per error.
     * Warnings are not collected: they are the schema processor's opinion, not
     * a conformance failure.
     */
    private static final class CollectingErrorHandler implements ErrorHandler {
        private final List<String> problems;

        private CollectingErrorHandler(List<String> problems) { this.problems = problems; }

        @Override public void warning(SAXParseException exception) {}
        @Override public void error(SAXParseException exception) { record(exception); }
        @Override public void fatalError(SAXParseException exception) { record(exception); }

        private void record(SAXParseException exception) {
            if (problems.size() >= MAX_REPORTED_PROBLEMS) return;
            String message = exception.getMessage() == null ? exception.getClass().getSimpleName() : exception.getMessage();
            problems.add(String.format("line %d: %s", exception.getLineNumber(), message.replaceAll("\\s+", " ").trim()));
        }
    }

    /** Only used by the tests, to prove the resolver never reaches the network. */
    static Reader bundledProvenance() {
        InputStream stream = FgsPackageValidator.class.getResourceAsStream("/fgs/PROVENANCE.txt");
        if (stream == null) throw new IllegalStateException("provenance missing");
        return new StringReader(new java.util.Scanner(stream, StandardCharsets.UTF_8).useDelimiter("\\A").next());
    }
}
