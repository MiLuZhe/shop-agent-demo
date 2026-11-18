#!/bin/sh
set -eu
mkdir -p /etc/nginx/templates
case "${TLS_MODE:-https}" in
  https|bootstrap) cp "/opt/shop-templates/${TLS_MODE:-https}.conf.template" /etc/nginx/templates/default.conf.template ;;
  *) echo 'Unsupported TLS_MODE' >&2; exit 1 ;;
esac
