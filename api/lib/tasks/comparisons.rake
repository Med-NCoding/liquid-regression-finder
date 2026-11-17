# frozen_string_literal: true

namespace :comparisons do
  desc "Reconcile missed queued comparisons and expired worker leases"
  task reconcile: :environment do
    summary = ComparisonReconciler.reconcile!
    puts JSON.generate(summary)
  end
end
