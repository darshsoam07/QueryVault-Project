export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.15";
  };
  public: {
    Tables: {
      document_chunks: {
        Row: {
          chunk_index: number;
          chunking_version: number;
          content: string;
          content_tsv: unknown;
          created_at: string;
          document_id: string;
          embedding: unknown;
          embedding_model: string | null;
          id: string;
          page_number: number;
          token_estimate: number;
          user_id: string;
        };
        Insert: {
          chunk_index?: number;
          chunking_version?: number;
          content: string;
          content_tsv?: unknown;
          created_at?: string;
          document_id: string;
          embedding?: unknown;
          embedding_model?: string | null;
          id?: string;
          page_number?: number;
          token_estimate?: number;
          user_id: string;
        };
        Update: {
          chunk_index?: number;
          chunking_version?: number;
          content?: string;
          content_tsv?: unknown;
          created_at?: string;
          document_id?: string;
          embedding?: unknown;
          embedding_model?: string | null;
          id?: string;
          page_number?: number;
          token_estimate?: number;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "document_chunks_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
        ];
      };
      documents: {
        Row: {
          attempt_count: number;
          byte_size: number;
          chunk_count: number;
          chunking_version: number;
          completed_at: string | null;
          content_hash: string | null;
          created_at: string;
          embedding_dimension: number | null;
          embedding_model: string | null;
          error_message: string | null;
          failure_code: string | null;
          failure_message: string | null;
          filename: string;
          id: string;
          ingestion_version: number;
          page_count: number;
          parser_version: number;
          phase: string;
          progress: number;
          started_at: string | null;
          status: string;
          storage_path: string | null;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          attempt_count?: number;
          byte_size?: number;
          chunk_count?: number;
          chunking_version?: number;
          completed_at?: string | null;
          content_hash?: string | null;
          created_at?: string;
          embedding_dimension?: number | null;
          embedding_model?: string | null;
          error_message?: string | null;
          failure_code?: string | null;
          failure_message?: string | null;
          filename: string;
          id?: string;
          ingestion_version?: number;
          page_count?: number;
          parser_version?: number;
          phase?: string;
          progress?: number;
          started_at?: string | null;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          attempt_count?: number;
          byte_size?: number;
          chunk_count?: number;
          chunking_version?: number;
          completed_at?: string | null;
          content_hash?: string | null;
          created_at?: string;
          embedding_dimension?: number | null;
          embedding_model?: string | null;
          error_message?: string | null;
          failure_code?: string | null;
          failure_message?: string | null;
          filename?: string;
          id?: string;
          ingestion_version?: number;
          page_count?: number;
          parser_version?: number;
          phase?: string;
          progress?: number;
          started_at?: string | null;
          status?: string;
          storage_path?: string | null;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      ingestion_jobs: {
        Row: {
          attempt_count: number;
          available_at: string;
          completed_at: string | null;
          created_at: string;
          document_id: string;
          error_code: string | null;
          error_message: string | null;
          id: string;
          kind: string;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          started_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
          worker_version: string | null;
        };
        Insert: {
          attempt_count?: number;
          available_at?: string;
          completed_at?: string | null;
          created_at?: string;
          document_id: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          kind?: string;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id: string;
          worker_version?: string | null;
        };
        Update: {
          attempt_count?: number;
          available_at?: string;
          completed_at?: string | null;
          created_at?: string;
          document_id?: string;
          error_code?: string | null;
          error_message?: string | null;
          id?: string;
          kind?: string;
          locked_at?: string | null;
          locked_by?: string | null;
          max_attempts?: number;
          started_at?: string | null;
          status?: string;
          updated_at?: string;
          user_id?: string;
          worker_version?: string | null;
        };
        Relationships: [
          {
            foreignKeyName: "ingestion_jobs_document_id_fkey";
            columns: ["document_id"];
            isOneToOne: false;
            referencedRelation: "documents";
            referencedColumns: ["id"];
          },
        ];
      };
      messages: {
        Row: {
          content: string;
          created_at: string;
          id: string;
          latency_ms: number | null;
          role: string;
          sources: Json;
          thread_id: string;
          user_id: string;
        };
        Insert: {
          content?: string;
          created_at?: string;
          id?: string;
          latency_ms?: number | null;
          role: string;
          sources?: Json;
          thread_id: string;
          user_id: string;
        };
        Update: {
          content?: string;
          created_at?: string;
          id?: string;
          latency_ms?: number | null;
          role?: string;
          sources?: Json;
          thread_id?: string;
          user_id?: string;
        };
        Relationships: [
          {
            foreignKeyName: "messages_thread_id_fkey";
            columns: ["thread_id"];
            isOneToOne: false;
            referencedRelation: "threads";
            referencedColumns: ["id"];
          },
        ];
      };
      profiles: {
        Row: {
          avatar_url: string | null;
          created_at: string;
          display_name: string | null;
          id: string;
          updated_at: string;
        };
        Insert: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          id: string;
          updated_at?: string;
        };
        Update: {
          avatar_url?: string | null;
          created_at?: string;
          display_name?: string | null;
          id?: string;
          updated_at?: string;
        };
        Relationships: [];
      };
      query_traces: {
        Row: {
          answer_preview: string | null;
          citations: Json;
          created_at: string;
          gate_reason: string | null;
          generation_latency_ms: number | null;
          grounded: boolean;
          id: string;
          question: string;
          refused: boolean;
          request_id: string;
          reranker: string | null;
          retrieval_latency_ms: number | null;
          stages: Json;
          thread_id: string | null;
          total_latency_ms: number | null;
          user_id: string;
        };
        Insert: {
          answer_preview?: string | null;
          citations?: Json;
          created_at?: string;
          gate_reason?: string | null;
          generation_latency_ms?: number | null;
          grounded?: boolean;
          id?: string;
          question: string;
          refused?: boolean;
          request_id: string;
          reranker?: string | null;
          retrieval_latency_ms?: number | null;
          stages?: Json;
          thread_id?: string | null;
          total_latency_ms?: number | null;
          user_id: string;
        };
        Update: {
          answer_preview?: string | null;
          citations?: Json;
          created_at?: string;
          gate_reason?: string | null;
          generation_latency_ms?: number | null;
          grounded?: boolean;
          id?: string;
          question?: string;
          refused?: boolean;
          request_id?: string;
          reranker?: string | null;
          retrieval_latency_ms?: number | null;
          stages?: Json;
          thread_id?: string | null;
          total_latency_ms?: number | null;
          user_id?: string;
        };
        Relationships: [];
      };
      rate_limit_events: {
        Row: {
          bucket: string;
          created_at: string;
          id: string;
          user_id: string;
        };
        Insert: {
          bucket: string;
          created_at?: string;
          id?: string;
          user_id: string;
        };
        Update: {
          bucket?: string;
          created_at?: string;
          id?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      telemetry_events: {
        Row: {
          attributes: Json;
          created_at: string;
          document_id: string | null;
          error_code: string | null;
          event: string;
          id: string;
          job_id: string | null;
          latency_ms: number | null;
          request_id: string;
          status: string;
          thread_id: string | null;
          user_id: string | null;
        };
        Insert: {
          attributes?: Json;
          created_at?: string;
          document_id?: string | null;
          error_code?: string | null;
          event: string;
          id?: string;
          job_id?: string | null;
          latency_ms?: number | null;
          request_id: string;
          status?: string;
          thread_id?: string | null;
          user_id?: string | null;
        };
        Update: {
          attributes?: Json;
          created_at?: string;
          document_id?: string | null;
          error_code?: string | null;
          event?: string;
          id?: string;
          job_id?: string | null;
          latency_ms?: number | null;
          request_id?: string;
          status?: string;
          thread_id?: string | null;
          user_id?: string | null;
        };
        Relationships: [];
      };
      threads: {
        Row: {
          created_at: string;
          id: string;
          title: string;
          updated_at: string;
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          title?: string;
          updated_at?: string;
          user_id?: string;
        };
        Relationships: [];
      };
      user_roles: {
        Row: {
          created_at: string;
          id: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Insert: {
          created_at?: string;
          id?: string;
          role: Database["public"]["Enums"]["app_role"];
          user_id: string;
        };
        Update: {
          created_at?: string;
          id?: string;
          role?: Database["public"]["Enums"]["app_role"];
          user_id?: string;
        };
        Relationships: [];
      };
      worker_credentials: {
        Row: {
          created_at: string;
          name: string;
          token: string;
        };
        Insert: {
          created_at?: string;
          name: string;
          token: string;
        };
        Update: {
          created_at?: string;
          name?: string;
          token?: string;
        };
        Relationships: [];
      };
    };
    Views: {
      [_ in never]: never;
    };
    Functions: {
      claim_ingestion_jobs: {
        Args: {
          lock_seconds?: number;
          max_jobs?: number;
          only_user_id?: string;
          worker_id: string;
          worker_version?: string;
        };
        Returns: {
          attempt_count: number;
          available_at: string;
          completed_at: string | null;
          created_at: string;
          document_id: string;
          error_code: string | null;
          error_message: string | null;
          id: string;
          kind: string;
          locked_at: string | null;
          locked_by: string | null;
          max_attempts: number;
          started_at: string | null;
          status: string;
          updated_at: string;
          user_id: string;
          worker_version: string | null;
        }[];
        SetofOptions: {
          from: "*";
          to: "ingestion_jobs";
          isOneToOne: false;
          isSetofReturn: true;
        };
      };
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"];
          _user_id: string;
        };
        Returns: boolean;
      };
      is_operator: { Args: { _user_id: string }; Returns: boolean };
      lexical_document_chunks: {
        Args: {
          document_ids?: string[];
          match_count?: number;
          query_text: string;
          requesting_user_id: string;
        };
        Returns: {
          chunk_index: number;
          content: string;
          document_id: string;
          filename: string;
          id: string;
          lexical_rank: number;
          page_number: number;
        }[];
      };
      match_document_chunks: {
        Args: {
          document_ids?: string[];
          match_count?: number;
          min_similarity?: number;
          query_embedding: unknown;
          requesting_user_id: string;
        };
        Returns: {
          chunk_index: number;
          content: string;
          document_id: string;
          filename: string;
          id: string;
          page_number: number;
          similarity: number;
        }[];
      };
      observability_summary: {
        Args: { window_minutes?: number };
        Returns: Json;
      };
      prune_stale_chunks: {
        Args: {
          keep_chunking_version: number;
          keep_max_index: number;
          target_document_id: string;
        };
        Returns: number;
      };
    };
    Enums: {
      app_role: "admin" | "operator" | "user";
    };
    CompositeTypes: {
      [_ in never]: never;
    };
  };
};

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">;

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">];

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R;
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R;
      }
      ? R
      : never
    : never;

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I;
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I;
      }
      ? I
      : never
    : never;

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    keyof DefaultSchema["Tables"] | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U;
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U;
      }
      ? U
      : never
    : never;

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    keyof DefaultSchema["Enums"] | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never;

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    keyof DefaultSchema["CompositeTypes"] | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals;
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals;
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never;

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operator", "user"],
    },
  },
} as const;
