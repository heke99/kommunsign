package se.kommunsign.validation;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.Executors;

public final class ValidationServiceApplication {
    private ValidationServiceApplication() {}
    public static void main(String[] args) throws IOException {
        int port=Integer.parseInt(System.getenv().getOrDefault("PORT","8082")); String token=required("VALIDATION_SERVICE_TOKEN");
        HttpServer server=HttpServer.create(new InetSocketAddress("0.0.0.0",port),64); server.setExecutor(Executors.newFixedThreadPool(4));
        TicBankIdEvidenceValidator validator=new TicBankIdEvidenceValidator();
        server.createContext("/health",exchange->json(exchange,200,Map.of("status","UP","validator","TIC_BANKID_XMLDSIG_V1","egress","NOT_REQUIRED")));
        server.createContext("/v1/validate/tic-bankid",exchange->{
            if(!"POST".equals(exchange.getRequestMethod())){json(exchange,405,Map.of("error","METHOD_NOT_ALLOWED"));return;}
            if(!constantTimeEquals("Bearer "+token,exchange.getRequestHeaders().getFirst("Authorization"))){json(exchange,401,Map.of("error","UNAUTHORIZED"));return;}
            String contentType=exchange.getRequestHeaders().getFirst("Content-Type"); if(contentType==null||!contentType.toLowerCase().startsWith("application/json")){json(exchange,415,Map.of("error","CONTENT_TYPE_REQUIRED"));return;}
            try{
                byte[] body=exchange.getRequestBody().readNBytes(5_000_001); if(body.length>5_000_000)throw new IllegalArgumentException("BODY_TOO_LARGE");
                Map<String,Object> parsed=TinyJson.parseObject(new String(body,StandardCharsets.UTF_8));
                TicBankIdValidationRequest request=new TicBankIdValidationRequest(TinyJson.string(parsed,"signatureXmlBase64",true),TinyJson.string(parsed,"ocspResponseBase64",true),TinyJson.string(parsed,"expectedVisibleData",true),TinyJson.string(parsed,"expectedNonVisibleData",true),TinyJson.string(parsed,"expectedPersonalNumber",false),TinyJson.string(parsed,"policyVersion",true));
                Map<String,Object> report=validator.validate(request); json(exchange,"PASS".equals(report.get("result"))?200:422,report);
            }catch(Exception exception){json(exchange,400,Map.of("error","VALIDATION_REQUEST_INVALID"));}
        });
        server.start();
    }
    private static void json(HttpExchange exchange,int status,Object value)throws IOException{byte[] body=TinyJson.stringify(value).getBytes(StandardCharsets.UTF_8);exchange.getResponseHeaders().set("Content-Type","application/json; charset=utf-8");exchange.getResponseHeaders().set("Cache-Control","no-store");exchange.getResponseHeaders().set("X-Content-Type-Options","nosniff");exchange.sendResponseHeaders(status,body.length);exchange.getResponseBody().write(body);exchange.close();}
    private static String required(String name){String value=System.getenv(name);if(value==null||value.isBlank())throw new IllegalStateException(name+"_MISSING");return value;}
    private static boolean constantTimeEquals(String expected,String actual){if(actual==null)return false;int diff=expected.length()^actual.length();for(int i=0;i<Math.max(expected.length(),actual.length());i++)diff|=expected.charAt(i%expected.length())^actual.charAt(i%actual.length());return diff==0;}
}
