package se.kommunsign.validation;

import java.util.*;

final class TinyJson {
    private TinyJson() {}
    static Map<String,Object> parseObject(String input) {
        Object parsed = new Parser(input).parse();
        if (!(parsed instanceof Map<?,?> map)) throw new IllegalArgumentException("JSON object required");
        Map<String,Object> result = new LinkedHashMap<>();
        for (var entry : map.entrySet()) result.put((String) entry.getKey(), entry.getValue());
        return result;
    }
    static String stringify(Object value) {
        if (value == null) return "null";
        if (value instanceof String string) return quote(string);
        if (value instanceof Boolean || value instanceof Number) return value.toString();
        if (value instanceof Map<?,?> map) {
            StringBuilder out = new StringBuilder("{"); boolean first = true;
            for (var entry : map.entrySet()) { if (!first) out.append(','); first=false; out.append(quote(String.valueOf(entry.getKey()))).append(':').append(stringify(entry.getValue())); }
            return out.append('}').toString();
        }
        if (value instanceof Iterable<?> values) { StringBuilder out=new StringBuilder("["); boolean first=true; for (Object item:values){if(!first)out.append(',');first=false;out.append(stringify(item));} return out.append(']').toString(); }
        throw new IllegalArgumentException("Unsupported JSON type");
    }
    static String string(Map<String,Object> object, String key, boolean required) {
        Object value=object.get(key); if (value==null && !required) return null; if (!(value instanceof String string)) throw new IllegalArgumentException(key+" must be a string"); return string;
    }
    private static String quote(String input) { StringBuilder out=new StringBuilder("\""); for(char c:input.toCharArray()){switch(c){case '"'->out.append("\\\"");case '\\'->out.append("\\\\");case '\b'->out.append("\\b");case '\f'->out.append("\\f");case '\n'->out.append("\\n");case '\r'->out.append("\\r");case '\t'->out.append("\\t");default->{if(c<0x20)out.append(String.format("\\u%04x",(int)c));else out.append(c);}}}return out.append('"').toString(); }
    private static final class Parser {
        private final String input; private int position;
        Parser(String input){this.input=input;}
        Object parse(){skip();Object value=value();skip();if(position!=input.length())throw error();return value;}
        private Object value(){skip();if(position>=input.length())throw error();return switch(input.charAt(position)){case '{'->object();case '['->array();case '"'->string();case 't'->{literal("true");yield true;}case 'f'->{literal("false");yield false;}case 'n'->{literal("null");yield null;}default->number();};}
        private Map<String,Object> object(){expect('{');Map<String,Object> map=new LinkedHashMap<>();skip();if(peek('}')){position++;return map;}while(true){String key=string();skip();expect(':');Object old=map.put(key,value());if(old!=null)throw new IllegalArgumentException("Duplicate JSON key");skip();if(peek('}')){position++;return map;}expect(',');}}
        private List<Object> array(){expect('[');List<Object> list=new ArrayList<>();skip();if(peek(']')){position++;return list;}while(true){list.add(value());skip();if(peek(']')){position++;return list;}expect(',');}}
        private String string(){expect('"');StringBuilder out=new StringBuilder();while(position<input.length()){char c=input.charAt(position++);if(c=='"')return out.toString();if(c=='\\'){if(position>=input.length())throw error();char e=input.charAt(position++);switch(e){case '"','\\','/'->out.append(e);case 'b'->out.append('\b');case 'f'->out.append('\f');case 'n'->out.append('\n');case 'r'->out.append('\r');case 't'->out.append('\t');case 'u'->{if(position+4>input.length())throw error();out.append((char)Integer.parseInt(input.substring(position,position+4),16));position+=4;}default->throw error();}}else{if(c<0x20)throw error();out.append(c);}}throw error();}
        private Number number(){int start=position;if(peek('-'))position++;while(position<input.length()&&Character.isDigit(input.charAt(position)))position++;if(peek('.')){position++;while(position<input.length()&&Character.isDigit(input.charAt(position)))position++;}if(peek('e')||peek('E')){position++;if(peek('+')||peek('-'))position++;while(position<input.length()&&Character.isDigit(input.charAt(position)))position++;}String raw=input.substring(start,position);try{return raw.contains(".")||raw.contains("e")||raw.contains("E")?Double.valueOf(raw):Long.valueOf(raw);}catch(Exception e){throw error();}}
        private void literal(String value){if(!input.startsWith(value,position))throw error();position+=value.length();}
        private void skip(){while(position<input.length()&&Character.isWhitespace(input.charAt(position)))position++;}
        private boolean peek(char c){return position<input.length()&&input.charAt(position)==c;}
        private void expect(char c){skip();if(!peek(c))throw error();position++;}
        private IllegalArgumentException error(){return new IllegalArgumentException("Invalid JSON at offset "+position);}
    }
}
