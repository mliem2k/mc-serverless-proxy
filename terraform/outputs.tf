output "catcher_static_ip" {
  value       = google_compute_address.catcher.address
  description = "Point mc.yourdomain.com and mc-backend.yourdomain.com's fallback A record at this. Also goes into idle_shutdown.ts's CATCHER_IP and setup-load-balancer.ts's STATIC_IP_NAME target."
}

output "catcher_service_account" {
  value       = google_compute_instance.catcher.service_account[0].email
  description = "Should match what catcher_wake_watcher.ts's metadata-server token resolves to."
}
