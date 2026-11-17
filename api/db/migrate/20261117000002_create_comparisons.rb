# frozen_string_literal: true

class CreateComparisons < ActiveRecord::Migration[8.1]
  def change
    create_table :comparisons, id: :string do |t|
      t.integer :schema_version, null: false, default: 1
      t.string :status, null: false
      t.text :request_json, null: false
      t.string :request_digest, null: false, limit: 64
      t.string :idempotency_key
      t.text :finding_json
      t.text :stats_json
      t.text :error_json
      t.string :attempt_token
      t.integer :attempts, null: false, default: 0
      t.datetime :lease_expires_at
      t.datetime :created_at, null: false
      t.datetime :completed_at
    end

    add_index :comparisons, :idempotency_key,
              unique: true,
              where: "idempotency_key IS NOT NULL",
              name: "index_comparisons_on_idempotency_key"
    add_index :comparisons, %i[status created_at], name: "index_comparisons_on_status_and_created_at"
    add_index :comparisons, %i[status lease_expires_at], name: "index_comparisons_on_status_and_lease_expires_at"
  end
end
