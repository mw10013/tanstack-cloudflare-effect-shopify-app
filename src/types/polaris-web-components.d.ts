import type * as React from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-link": React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLElement> & { href?: string }, HTMLElement>;
      "s-page": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string }, HTMLElement>;
      "s-section": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string; slot?: string }, HTMLElement>;
      "s-paragraph": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-text": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { fontWeight?: string }, HTMLElement>;
      "s-button": React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLElement> & { variant?: string; loading?: boolean }, HTMLElement>;
      "s-text-field": React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLElement> & { label?: string; details?: string; error?: string }, HTMLElement>;
      "s-heading": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-box": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { padding?: string; borderWidth?: string; borderRadius?: string; background?: string }, HTMLElement>;
      "s-stack": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { direction?: string; gap?: string }, HTMLElement>;
      "s-unordered-list": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-list-item": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}

declare module "react/jsx-runtime" {
  namespace JSX {
    interface IntrinsicElements {
      "s-app-nav": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-link": React.DetailedHTMLProps<React.AnchorHTMLAttributes<HTMLElement> & { href?: string }, HTMLElement>;
      "s-page": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string }, HTMLElement>;
      "s-section": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { heading?: string; slot?: string }, HTMLElement>;
      "s-paragraph": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-text": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { fontWeight?: string }, HTMLElement>;
      "s-button": React.DetailedHTMLProps<React.ButtonHTMLAttributes<HTMLElement> & { variant?: string; loading?: boolean }, HTMLElement>;
      "s-text-field": React.DetailedHTMLProps<React.InputHTMLAttributes<HTMLElement> & { label?: string; details?: string; error?: string }, HTMLElement>;
      "s-heading": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-box": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { padding?: string; borderWidth?: string; borderRadius?: string; background?: string }, HTMLElement>;
      "s-stack": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement> & { direction?: string; gap?: string }, HTMLElement>;
      "s-unordered-list": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
      "s-list-item": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>;
    }
  }
}
