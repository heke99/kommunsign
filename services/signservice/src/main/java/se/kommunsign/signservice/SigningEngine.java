package se.kommunsign.signservice;

public interface SigningEngine {
    SignResult sign(SignCommand command);
}
