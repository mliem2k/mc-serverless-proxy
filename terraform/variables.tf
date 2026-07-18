variable "project_id" {
  type        = string
  description = "GCP project ID both VMs are created in."
}

variable "catcher_zone" {
  type        = string
  description = "Zone for the always-on catcher VM. Must be an Always Free eligible zone (us-west1-*, us-central1-*, or us-east1-*) for the e2-micro to actually be free."
  default     = "us-west1-a"
}

variable "relay_zone" {
  type        = string
  description = "Zone for the on-demand relay VM. Pick whatever region you actually want low latency for, it does not need to be a free-tier region since the relay only runs a few hours a week."
  default     = "asia-southeast1-b"
}

variable "ssh_source_ranges" {
  type        = list(string)
  description = "CIDR ranges allowed to reach :22 on either VM. Defaults to open; narrow this to your own IP if you want tighter SSH exposure."
  default     = ["0.0.0.0/0"]
}
