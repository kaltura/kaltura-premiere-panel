import React from "react";
import { render, screen, fireEvent } from "@testing-library/react";
import { LoginPanel } from "../../src/panels/LoginPanel";

const defaultProps = {
  onLogin: jest.fn().mockResolvedValue(undefined),
  isLoading: false,
  error: null,
  onClearError: jest.fn(),
};

describe("LoginPanel", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("renders sign-in form when not loading", () => {
    render(<LoginPanel {...defaultProps} />);
    expect(screen.getByText("Sign In")).toBeTruthy();
  });

  it("shows the plugin name", () => {
    render(<LoginPanel {...defaultProps} />);
    expect(screen.getByText("Kaltura")).toBeTruthy();
  });

  it("shows loading spinner when isLoading is true", () => {
    render(<LoginPanel {...defaultProps} isLoading={true} />);
    expect(screen.getByText("Signing in...")).toBeTruthy();
    expect(screen.queryByText("Sign In")).toBeNull();
  });

  it("shows error banner when error prop is set", () => {
    render(<LoginPanel {...defaultProps} error="Invalid credentials" />);
    expect(screen.getByText("Invalid credentials")).toBeTruthy();
  });

  it("shows SSO tab when onSsoInitiate is provided", () => {
    const onSsoInitiate = jest.fn();
    render(<LoginPanel {...defaultProps} onSsoInitiate={onSsoInitiate} />);
    expect(screen.getByText("SSO")).toBeTruthy();
    expect(screen.getByText("Email")).toBeTruthy();
  });

  it("does not show SSO tab when onSsoInitiate is not provided", () => {
    render(<LoginPanel {...defaultProps} />);
    expect(screen.queryByText("SSO")).toBeNull();
  });

  it("shows a region dropdown (not a free-text server URL) when server settings are opened", () => {
    render(<LoginPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("Configure server"));
    expect(screen.getByLabelText("Kaltura region")).toBeTruthy();
    expect(screen.queryByLabelText("Custom Kaltura server URL")).toBeNull();
  });

  it("shows the custom server URL field only when 'Custom' region is selected", () => {
    render(<LoginPanel {...defaultProps} />);
    fireEvent.click(screen.getByText("Configure server"));
    fireEvent.change(screen.getByLabelText("Kaltura region"), { target: { value: "custom" } });
    expect(screen.getByLabelText("Custom Kaltura server URL")).toBeTruthy();
  });

  it("reports the region's server URL when a SaaS region is picked", () => {
    const onServerUrlChange = jest.fn();
    render(<LoginPanel {...defaultProps} onServerUrlChange={onServerUrlChange} />);
    fireEvent.click(screen.getByText("Configure server"));
    fireEvent.change(screen.getByLabelText("Kaltura region"), { target: { value: "frp2" } });
    expect(onServerUrlChange).toHaveBeenCalledWith("https://api.de.kaltura.com");
  });
});
